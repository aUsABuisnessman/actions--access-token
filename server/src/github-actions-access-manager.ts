import {Octokit} from '@octokit/rest'
import {formatZodIssue, YamlTransformer} from './common/zod-utils.js'
import {
  _throw,
  ensureHasEntries,
  escapeRegexp,
  filterObjectEntries,
  hasEntries,
  indent,
  isRecord,
  mapObjectEntries,
  retry,
  unique,
} from './common/common-utils.js'
import {z, ZodSchema} from 'zod'
import {
  aggregatePermissions,
  GitHubActionsJwtPayload,
  GitHubAppPermissions,
  GitHubAppPermissionsSchema,
  GitHubAppRepositoryPermissions,
  GitHubAppRepositoryPermissionsSchema,
  GitHubRepositorySchema,
  normalizePermissionScopes,
  parseOIDCSubject,
  verifyPermissions,
  verifyRepositoryPermissions,
} from './common/github-utils.js'
import {Status} from './common/http-utils.js'
import {components} from '@octokit/openapi-types'
import {createAppAuth} from '@octokit/auth-app'
import limit from 'p-limit'
import log from './logger.js'
import type {
  RestEndpointMethodTypes,
} from '@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types'

/**
 * GitHub Access Manager
 * @param options - options
 * @return access token manager
 */
export async function accessTokenManager(options: {
  githubAppAuth: { appId: string, privateKey: string, },
  accessPolicyLocation: {
    owner: { repo: string, path: string,},
    repo: { path: string}
}}) {
  log.debug({appId: options.githubAppAuth.appId}, 'GitHub app')
  const GITHUB_APP_CLIENT = new Octokit({authStrategy: createAppAuth, auth: options.githubAppAuth})
  const GITHUB_APP = await GITHUB_APP_CLIENT.apps.getAuthenticated()
      .then((res) => res.data ?? _throw(new Error('GitHub app not found.')))

  /**
   * Creates a GitHub Actions Access Token
   * @param callerIdentity - caller identity
   * @param tokenRequest - token request
   * @return access token
   */
  async function createAccessToken(
      callerIdentity: GitHubActionsJwtPayload,
      tokenRequest: {
        owner: string, repositories?: string[],
        scope: 'owner', permissions: GitHubAppPermissions,
      } | {
        owner: string, repositories: string[],
        scope: 'repos', permissions: GitHubAppRepositoryPermissions
      },
  ) {
    const appInstallation = await getAppInstallation(GITHUB_APP_CLIENT, {
      owner: tokenRequest.owner,
    })
    if (!appInstallation) {
      throw new GithubAccessTokenError(`${GITHUB_APP.name} has not been installed for ${tokenRequest.owner}.\n` +
          `Install from ${GITHUB_APP.html_url}`)
    }
    log.debug({appInstallation}, 'App installation')

    // --- verify requested token permissions ------------------------------------------------------------------------
    // grant requested permissions explicitly to prevent accidental permission escalation
    const grantedTokenPermissions: Record<string, string> = {}
    {
      const pendingTokenPermissions: Record<string, string> = {...tokenRequest.permissions}
      const rejectedTokenPermissions: {
        reason: string,
        scope: string, permission: string,
      }[] = []

      const appInstallationClient = await createOctokit(GITHUB_APP_CLIENT, appInstallation, {
        // single_file to read access policy files
        permissions: {single_file: 'read'},
      })

      // --- verify app installation permissions ---------------------------------------------------------------------
      verifyPermissions({
        requested: tokenRequest.permissions,
        granted: normalizePermissionScopes(appInstallation.permissions),
      }).denied.forEach(({scope, permission}) => {
        rejectedTokenPermissions.push({
          reason: `Permission has not been granted to ${GITHUB_APP.name} installation for ${tokenRequest.owner}.`,
          scope, permission,
        })
      })

      if (hasEntries(rejectedTokenPermissions)) {
        throw new GithubAccessTokenError(createErrorMessage(rejectedTokenPermissions))
      }

      // --- load owner access policy ----------------------------------------------------------------------------------
      const ownerAccessPolicy = await getOwnerAccessPolicy(appInstallationClient, {
        owner: tokenRequest.owner, repo: options.accessPolicyLocation.owner.repo,
        path: options.accessPolicyLocation.owner.path,
        strict: false, // ignore invalid access policy entries
      })
      log.debug({ownerAccessPolicy}, `${tokenRequest.owner} access policy:`)

      // --- verify allowed caller identities --------------------------------------------------------------------------
      const effectiveCallerIdentitySubjects = getEffectiveCallerIdentitySubjects(callerIdentity)

      if (ownerAccessPolicy['allowed-subjects'].length > 0) {
        if (!ownerAccessPolicy['allowed-subjects'].some((it) => effectiveCallerIdentitySubjects
            .some((subject) => matchSubjectPattern(it, subject, false)))) {
          throw new GithubAccessTokenError(
              `OIDC token subject is not allowed by ${tokenRequest.owner} owner access policy.\n` +
              'Effective token subjects:\n' +
              effectiveCallerIdentitySubjects.map((subject) => `- ${subject}`,).join('\n'))
        }
      }

      const ownerGrantedPermissions = evaluateGrantedPermissions({
        statements: ownerAccessPolicy.statements,
        callerIdentitySubjects: effectiveCallerIdentitySubjects,
      })

      // --- verify scope permissions ----------------------------------------------------------------------------------
      switch (tokenRequest.scope) {
        case 'owner': {
          // --- grant permissions that are granted by owner access policy
          verifyPermissions({
            granted: ownerGrantedPermissions,
            requested: pendingTokenPermissions,
          }).granted.forEach(({scope, permission}) => {
            // permission granted
            grantedTokenPermissions[scope] = permission
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete pendingTokenPermissions[scope]
          })

          // --- reject all pending permissions
          Object.entries(pendingTokenPermissions).forEach(([scope, permission]) => {
            rejectedTokenPermissions.push({
              reason: `Permission has not been granted by ${tokenRequest.owner}.`,
              scope, permission,
            })
          })
          break
        }
        case 'repos': {
          // --- verify repo permissions by OWNER access policy --------------------------------------------------------
          {
            // --- grant repo permissions that are granted by owner access policy
            verifyPermissions({
              // BE AWARE to grant repository permissions only
              granted: verifyRepositoryPermissions(ownerGrantedPermissions).valid,
              requested: pendingTokenPermissions,
            }).granted.forEach(({scope, permission}) => {
              grantedTokenPermissions[scope] = permission
              // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
              delete pendingTokenPermissions[scope]
            })

            // --- reject repo permissions that are not explicitly granted by owner access policy
            verifyPermissions({
              // BE AWARE to grant repository permissions only
              granted: verifyRepositoryPermissions(ownerAccessPolicy['allowed-repository-permissions']).valid,
              requested: pendingTokenPermissions,
            }).denied.forEach(({scope, permission}) => {
              rejectedTokenPermissions.push({
                reason: `Permission is not allowed by ${tokenRequest.owner} owner policy.`,
                scope, permission,
              })
            })
          }

          if (hasEntries(rejectedTokenPermissions)) {
            break
          }

          // --- verify repo permissions by target REPOSITORY access policy --------------------------------------------
          {
            // BE AWARE to grant repository permissions only
            const pendingRepositoryTokenPermissions = verifyRepositoryPermissions(pendingTokenPermissions).valid
            if (hasEntries(pendingRepositoryTokenPermissions)) {
              const pendingRepositoryTokenScopesByRepository: Record<string, Set<string>> =
                  Object.fromEntries(Object.keys(pendingRepositoryTokenPermissions)
                      .map((scope) => [scope, new Set(tokenRequest.repositories)]))

              const limitRepoPermissionRequests = limit(8)
              await Promise.all(
                  tokenRequest.repositories.map((repo) => limitRepoPermissionRequests(async () => {
                    const repoAccessPolicy = await getRepoAccessPolicy(appInstallationClient, {
                      owner: tokenRequest.owner, repo,
                      path: options.accessPolicyLocation.repo.path,
                      strict: false, // ignore invalid access policy entries
                    })
                    log.debug({repoAccessPolicy}, `${tokenRequest.owner}/${repo} access policy`)

                    const repoGrantedPermissions = evaluateGrantedPermissions({
                      statements: repoAccessPolicy.statements,
                      callerIdentitySubjects: effectiveCallerIdentitySubjects,
                    })

                    const verifiedRepoPermissions = verifyPermissions({
                      granted: repoGrantedPermissions,
                      requested: pendingTokenPermissions,
                    })
                    // --- grant repo permissions that are granted by repo access policy
                    verifiedRepoPermissions.granted.forEach(({scope}) => {
                      pendingRepositoryTokenScopesByRepository[scope].delete(repo)
                    })
                    // --- reject repo permissions that are not granted by repo access policy
                    verifiedRepoPermissions.denied.forEach(({scope, permission}) => {
                      rejectedTokenPermissions.push({
                        reason: `Permission has not been granted by ${tokenRequest.owner}/${repo}.`,
                        scope, permission,
                      })
                    })
                  })),
              )

              // --- grant repo permission only if all repositories have granted the specific permission
              Object.entries(pendingRepositoryTokenScopesByRepository).forEach(([scope, repositories]) => {
                if (repositories.size == 0) {
                  grantedTokenPermissions[scope] = pendingTokenPermissions[scope]
                  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                  delete pendingTokenPermissions[scope]
                }
              })
            }
          }

          break
        }
      }

      if (hasEntries(rejectedTokenPermissions)) {
        throw new GithubAccessTokenError(createErrorMessage(rejectedTokenPermissions, effectiveCallerIdentitySubjects))
      }
      // SAFEGUARD: ensure that all requested permissions have been granted. This should never happen.
      if (hasEntries(pendingTokenPermissions)) {
        throw new Error('Unexpected pending permissions.')
      }
    }

    // --- create requested access token -------------------------------------------------------------------------------
    const accessToken = await createInstallationAccessToken(
        GITHUB_APP_CLIENT, appInstallation, {
          // BE AWARE that an empty object will result in a token with all app installation permissions
          permissions: ensureHasEntries(grantedTokenPermissions),
          // BE AWARE that an empty array will result in a token with access to all app installation repositories
          repositories: tokenRequest.scope === 'repos' ? ensureHasEntries(tokenRequest.repositories) : undefined,
        })

    return {
      owner: appInstallation.account?.name ?? tokenRequest.owner,
      ...accessToken,
    }
  }

  return {
    createAccessToken,
  }
}

// --- Access Manager Functions --------------------------------------------------------------------------------------

/**
 * Create error message
 * @param rejectedTokenPermissions - rejected token permissions
 * @param callerIdentitySubjects - caller identity subjects
 * @return error message
 */
function createErrorMessage(
    rejectedTokenPermissions: {
      reason: string,
      scope: string, permission: string,
    }[],
    callerIdentitySubjects?: string[]
): string {
  let message = 'Some requested permissions got rejected.\n' +
      rejectedTokenPermissions.map(({scope, permission, reason}) => '' +
          '- ' + `${scope}: ${permission}\n` +
          indent(reason),
      ).join('\n')

  if (callerIdentitySubjects?.length) {
    message += '\n' +
        'Effective token subjects:\n' +
        callerIdentitySubjects.map((subject) => `- ${subject}`,).join('\n')
  }
  return message
}

/**
 * Get owner access policy
 * @param client - GitHub client for target repository
 * @param owner - repository owner
 * @param repo - repository name
 * @param path - file path
 * @param strict - throw error on invalid access policy
 * @return access policy
 */
async function getOwnerAccessPolicy(client: Octokit, {owner, repo, path, strict}: {
  owner: string,
  repo: string,
  path: string,
  strict: boolean,
}): Promise<Omit<GitHubOwnerAccessPolicy, 'origin'>> {
  const emptyPolicy: Omit<GitHubOwnerAccessPolicy, 'origin'> = {
    'statements': [],
    'allowed-subjects': [],
    'allowed-repository-permissions': {},
  }
  const policyValue = await getRepositoryFileContent(client, {
    owner, repo, path,
    maxSize: 100 * 1024, // 100kb
  })

  if (!policyValue) {
    return emptyPolicy
  }

  const policyParseResult = YamlTransformer
      .transform((policyObject) => {
        if (strict) return policyObject

        // ignore invalid entries
        if (isRecord(policyObject)) {
          if (Array.isArray(policyObject['allowed-subjects'])) {
            policyObject['allowed-subjects'] = filterValidSubjects(
                policyObject['allowed-subjects'])
          }
          if (isRecord(policyObject['allowed-repository-permissions'])) {
            policyObject['allowed-repository-permissions'] = filterValidPermissions(
                policyObject['allowed-repository-permissions'], 'owner')
          }
          if (Array.isArray(policyObject.statements)) {
            policyObject.statements = filterValidStatements(
                policyObject.statements, 'owner')
          }
        }

        return policyObject
      })
      .pipe(GitHubOwnerAccessPolicySchema)
      .safeParse(policyValue)

  if (policyParseResult.error) {
    const issues = policyParseResult.error.issues.map(formatZodIssue)
    if (strict) {
      throw new GithubAccessPolicyError(`${owner} access policy is invalid.`, issues)
    }
    log.debug({issues}, `${owner} access policy is invalid.`)
    return emptyPolicy
  }

  const policy = policyParseResult.data

  const expectedPolicyOrigin = `${owner}/${repo}`
  if (policy.origin.toLowerCase() !== expectedPolicyOrigin.toLowerCase()) {
    const issues = [`policy origin '${policy.origin}' does not match repository '${expectedPolicyOrigin}'`]
    if (strict) {
      throw new GithubAccessPolicyError(`${owner} owner access policy is invalid.`, issues)
    }
    log.debug({issues}, `${owner} owner access policy is invalid.`)
    return emptyPolicy
  }

  policy.statements.forEach((statement) => {
    normaliseAccessPolicyStatement(statement, {owner, repo})
  })

  return policy
}

/**
 * Get repository access policy
 * @param client - GitHub client for target repository
 * @param owner - repository owner
 * @param repo - repository name
 * @param path - file path
 * @param strict - throw error on invalid access policy
 * @return access policy
 */
async function getRepoAccessPolicy(client: Octokit, {owner, repo, path, strict}: {
  owner: string,
  repo: string,
  path: string,
  strict: boolean,
}): Promise<Omit<GitHubRepositoryAccessPolicy, 'origin'>> {
  const emptyPolicy: Omit<GitHubRepositoryAccessPolicy, 'origin'> = {
    statements: [],
  }
  const policyValue = await getRepositoryFileContent(client, {
    owner, repo, path,
    maxSize: 100 * 1024, // 100kb
  })
  if (!policyValue) {
    return emptyPolicy
  }

  const policyParseResult = YamlTransformer
      .transform((policyObject) => {
        if (strict) return policyObject
        // ignore invalid entries
        if (isRecord(policyObject) && Array.isArray(policyObject.statements)) {
          policyObject.statements = filterValidStatements(
              policyObject.statements, 'repo')
        }
        return policyObject
      })
      .pipe(GitHubRepositoryAccessPolicySchema)
      .safeParse(policyValue)

  if (policyParseResult.error) {
    const issues = policyParseResult.error.issues.map(formatZodIssue)
    if (strict) {
      throw new GithubAccessPolicyError(`${owner}/${repo} repository access policy is invalid.`, issues)
    }
    log.debug({issues}, `${owner}/${repo} repository access policy is invalid.`)
    return emptyPolicy
  }

  const policy = policyParseResult.data

  const expectedPolicyOrigin = `${owner}/${repo}`
  if (policy.origin.toLowerCase() !== expectedPolicyOrigin.toLowerCase()) {
    const issues = [`policy origin '${policy.origin}' does not match repository '${expectedPolicyOrigin}'`]
    if (strict) {
      throw new GithubAccessPolicyError(`${owner} access policy is invalid.`, issues)
    }
    log.debug({issues}, `${owner} access policy is invalid.`)
    return emptyPolicy
  }

  policy.statements.forEach((statement) => {
    normaliseAccessPolicyStatement(statement, {owner, repo})
  })

  return policy
}

/**
 * Filter invalid access policy statements
 * @param statements - access policy statements
 * @param permissionsType - permission type
 * @return valid statements
 */
function filterValidStatements(statements: unknown[], permissionsType: 'owner' | 'repo')
    : unknown | GitHubAccessStatement[] {
  return statements
      .map((statementObject: unknown) => {
        if (isRecord(statementObject)) {
          // ---- subjects
          if ('subjects' in statementObject && Array.isArray(statementObject.subjects)) {
            // ignore invalid subjects
            statementObject.subjects = filterValidSubjects(statementObject.subjects)
          }
          // ---- permissions
          if ('permissions' in statementObject && isRecord(statementObject.permissions)) {
            // ignore invalid permissions
            statementObject.permissions = filterValidPermissions(statementObject.permissions, permissionsType)
          }
        }
        return statementObject
      })
      .filter((statementObject: unknown) => GitHubAccessStatementSchema.safeParse(statementObject).success)
}

/**
 * Filter invalid subjects
 * @param subjects - access policy subjects
 * @return valid subjects
 */
function filterValidSubjects(subjects: unknown[]): unknown[] {
  return subjects.filter((it: unknown) => GitHubSubjectClaimSchema.safeParse(it).success)
}

/**
 * Filter invalid permissions
 * @param permissions - access policy permissions
 * @param type - permission type
 * @return valid permissions
 */
function filterValidPermissions(permissions: Record<string, unknown>, type: 'owner' | 'repo')
    : Record<string, unknown> {
  let permissionSchema: ZodSchema
  switch (type) {
    case 'owner':
      permissionSchema = GitHubAppPermissionsSchema
      break
    case 'repo':
      permissionSchema = GitHubAppRepositoryPermissionsSchema
      break
    default:
      throw new Error('Invalid permission type.')
  }

  return filterObjectEntries(permissions, ([key, value]) => permissionSchema.safeParse({[key]: value}).success)
}

/**
 * Normalise access policy statement
 * @param statement - access policy statement
 * @param owner - policy owner
 * @param repo - policy repository
 * @return void
 */
function normaliseAccessPolicyStatement(statement: { subjects: string[] }, {owner, repo}: {
  owner: string,
  repo: string,
}) {
  statement.subjects = statement.subjects
      .map((it) => normaliseAccessPolicyStatementSubject(it, {owner, repo}))
}

/**
 * Normalise access policy statement subject
 * @param subject - access policy statement subject
 * @param owner - policy owner
 * @param repo - policy repository
 * @return normalised subject
 */
function normaliseAccessPolicyStatementSubject(subject: string, {owner, repo}: {
  owner: string,
  repo: string
}): string {
  return subject.replaceAll('${origin}', `${owner}/${repo}`)
}

/**
 * Evaluate granted permissions for caller identity
 * @param accessPolicy - access policy
 * @param callerIdentitySubjects - caller identity subjects
 * @return granted permissions
 */
function evaluateGrantedPermissions({statements, callerIdentitySubjects}: {
  statements: GitHubAccessStatement[],
  callerIdentitySubjects: string[],
}): Record<string, string> {
  const permissions = statements
      .filter(statementSubjectPredicate(callerIdentitySubjects))
      .map((it) => it.permissions)

  return aggregatePermissions(permissions)

  /**
   * Create statement subject predicate
   * @param subjects - caller identity subjects
   * @return true if statement subjects match any of the given subject patterns
   */
  function statementSubjectPredicate(subjects: string[]) {
    return (statement: GitHubAccessStatement) => subjects
        .some((subject) => statement.subjects
            .some((subjectPattern) => matchSubjectPattern(subjectPattern, subject)))
  }
}

/**
 * Get effective caller identity subjects
 * @param callerIdentity - caller identity
 * @return effective caller identity subjects
 */
function getEffectiveCallerIdentitySubjects(callerIdentity: GitHubActionsJwtPayload): string[] {
  const subjects = [callerIdentity.sub]

  // --- add artificial subjects

  // repo : ref
  // => repo:qoomon/sandbox:ref:refs/heads/main
  subjects.push(`repo:${callerIdentity.repository}:ref:${callerIdentity.ref}`)

  // repo : workflow_ref
  // => repo:qoomon/sandbox:workflow_ref:qoomon/sandbox/.github/workflows/build.yml@refs/heads/main
  subjects.push(`repo:${callerIdentity.repository}:workflow_ref:${callerIdentity.workflow_ref}`)

  // repo : job_workflow_ref
  // => repo:qoomon/sandbox:job_workflow_ref:qoomon/sandbox/.github/workflows/build.yml@refs/heads/main
  subjects.push(`repo:${callerIdentity.repository}:job_workflow_ref:${callerIdentity.job_workflow_ref}`)

  if (callerIdentity.environment) {
    // repo : environment
    // => repo:qoomon/sandbox:environment:production
    subjects.push(`repo:${callerIdentity.repository}:environment:${callerIdentity.environment}`)
  }

  return unique(subjects)
}

/**
 * Verify if subject is granted by grantedSubjectPatterns
 * @param subjectPattern - subject pattern
 * @param subject - subject e.g. 'repo:spongebob/sandbox:ref:refs/heads/main'
 * @param strict - strict mode does not allow ** wildcards
 * @return true if subject matches any granted subject pattern
 */
function matchSubjectPattern(subjectPattern: string, subject: string, strict = true): boolean {
  if (strict && subjectPattern.includes('**')) {
    return false
  }

  // claims must not contain wildcards to prevent granting access accidentally e.g. pull requests
  // e.g. repo:foo/bar:* is not allowed
  if (Object.keys(parseOIDCSubject(subjectPattern))
      .some((claim) => claim !== '**' && claim.includes('*'))) {
    return false
  }

  // grantedSubjectPattern example: repo:qoomon/sandbox:ref:refs/heads/*
  // identity.sub example:     repo:qoomon/sandbox:ref:refs/heads/main
  return regexpOfSubjectPattern(subjectPattern).test(subject)
}

/**
 * Create regexp of wildcard subject pattern
 * @param subjectPattern - wildcard subject pattern
 * @return regexp
 */
function regexpOfSubjectPattern(subjectPattern: string): RegExp {
  const regexp = escapeRegexp(subjectPattern)
      .replace(/\\\*\\\*/g, '.*')
      .replace(/\\\*/g, '[^:]*') // replace * with match one or more characters except ':' char
      .replace(/\\\?/g, '[^:]') // replace ? with match one characters except ':' char
  return RegExp(`^${regexp}$`, 'i')
}


// --- GitHub Functions ----------------------------------------------------------------------------------------------

/**
 * Get GitHub app installation for a repository or owner
 * @param client - GitHub client
 * @param owner - app installation owner
 * @return installation or null if app is not installed for target
 */
async function getAppInstallation(client: Octokit, {owner}: {
  owner: string
}): Promise<GitHubAppInstallation | null> {
  // WORKAROUND: for some reason sometimes the request connection get closed unexpectedly (line closed),
  // therefore we retry on any error
  return await retry(
      async () => client.apps.getUserInstallation({username: owner})
          .then((res) => res.data)
          .catch(async (error) => error.status === Status.NOT_FOUND ? null : _throw(error)),
      {
        delay: 1000,
        retries: 3,
      })
}

/**
 * Create installation access token
 * @param client - GitHub client
 * @param installation - target installation id
 * @param repositories - target repositories
 * @param permissions - requested permissions
 * @return access token
 */
async function createInstallationAccessToken(client: Octokit, installation: GitHubAppInstallation, {
  repositories, permissions,
}: {
  repositories?: string[],
  permissions: GitHubAppPermissions
}): Promise<GitHubAppInstallationAccessToken> {
  // noinspection TypeScriptValidateJSTypes
  return await client.apps.createInstallationAccessToken({
    installation_id: installation.id,
    // BE AWARE that an empty object will result in a token with all app installation permissions
    permissions: ensureHasEntries(mapObjectEntries(permissions, ([scope, permission]) => [
      scope.replaceAll('-', '_'), permission,
    ])),
    repositories,
  })
      .then((res) => res.data)
}

/**
 * Create octokit instance for app installation
 * @param client - GitHub client
 * @param installation - app installation
 * @param permissions - requested permissions
 * @param repositories - requested repositories
 * @return octokit instance
 */
async function createOctokit(client: Octokit, installation: GitHubAppInstallation, {permissions, repositories}: {
  permissions: components['schemas']['app-permissions'],
  repositories?: string[]
}): Promise<Octokit> {
  const installationAccessToken = await createInstallationAccessToken(client, installation, {
    permissions,
    repositories,
  })
  return new Octokit({auth: installationAccessToken.token})
}

/**
 * Get repository file content
 * @param client - GitHub client for target repository
 * @param owner - repository owner
 * @param repo - repository name
 * @param path - file path
 * @param maxSize - max file size
 * @return file content or null if file does not exist
 */
async function getRepositoryFileContent(client: Octokit, {owner, repo, path, maxSize}: {
  owner: string,
  repo: string,
  path: string,
  maxSize?: number
}): Promise<string | null> {
  return await client.repos.getContent({owner, repo, path})
      .then((res) => {
        if ('type' in res.data && res.data.type === 'file') {
          if (maxSize !== undefined && res.data.size > maxSize) {
            throw new Error(`Expect file size to be less than ${maxSize}b, but was ${res.data.size}b` +
                `${owner}/${repo}/${path}`)
          }
          return Buffer.from(
              res.data.content,
              'base64').toString()
        }

        throw new Error('Unexpected file content')
      })
      .catch((error) => {
        if (error.status === Status.NOT_FOUND) return null
        throw error
      })
}


// --- Errors ------------------------------------------------------------------------------------------------------

/**
 * Represents a GitHub access token error
 */
export class GithubAccessTokenError extends Error {
  /**
   * Creates a new GitHub access token error
   * @param msg - error message
   */
  constructor(msg: string,) {
    super(msg)

    Object.setPrototypeOf(this, GithubAccessTokenError.prototype)
  }
}

/**
 * Access Policy Error
 */
export class GithubAccessPolicyError extends Error {
  public issues?: string[]

  /**
   * @param message - error message
   * @param issues - list of issues
   */
  constructor(message: string, issues?: string[]) {
    super(message)
    this.issues = issues
  }
}


// --- Schemas ---------------------------------------------------------------------------------------------------------

// https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect#example-subject-claims
const GitHubSubjectClaimSchema = z.string().trim()

const GitHubBaseStatementSchema = z.strictObject({
  subjects: z.array(GitHubSubjectClaimSchema),
})

const GitHubAccessStatementSchema = GitHubBaseStatementSchema.merge(z.strictObject({
  permissions: GitHubAppPermissionsSchema,
}))
type GitHubAccessStatement = z.infer<typeof GitHubAccessStatementSchema>

const GitHubRepositoryAccessStatementSchema = GitHubBaseStatementSchema.merge(z.strictObject({
  permissions: GitHubAppRepositoryPermissionsSchema,
}))
export type GitHubRepositoryAccessStatement = z.infer<typeof GitHubRepositoryAccessStatementSchema>

const GitHubOwnerAccessPolicySchema = z.strictObject({
  'origin': GitHubRepositorySchema,
  'statements': z.array(GitHubAccessStatementSchema).default([]),
  'allowed-subjects': z.array(GitHubSubjectClaimSchema).default([]),
  'allowed-repository-permissions': GitHubAppRepositoryPermissionsSchema.default({}),
})
export type GitHubOwnerAccessPolicy = z.infer<typeof GitHubOwnerAccessPolicySchema>

const GitHubRepositoryAccessPolicySchema = z.strictObject({
  'origin': GitHubRepositorySchema,
  'statements': z.array(GitHubRepositoryAccessStatementSchema).default([]),
})
export type GitHubRepositoryAccessPolicy = z.infer<typeof GitHubRepositoryAccessPolicySchema>

type GitHubAppInstallation = RestEndpointMethodTypes['apps']['getUserInstallation']['response']['data']
// eslint-disable-next-line max-len
type GitHubAppInstallationAccessToken = RestEndpointMethodTypes['apps']['createInstallationAccessToken']['response']['data']
