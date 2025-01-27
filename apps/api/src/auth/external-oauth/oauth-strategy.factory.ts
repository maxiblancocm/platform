import { IntegrationAuthType } from '@app/definitions/types/IntegrationAuthDefinition'
import { BadRequestException, forwardRef, Inject, Injectable, Logger } from '@nestjs/common'
import { Handler } from 'express'
import passport, { Profile } from 'passport'
import { Strategy as OAuth1Strategy } from 'passport-oauth1'
import { Strategy as OAuth2Strategy } from 'passport-oauth2'
import refresh from 'passport-oauth2-refresh'
import { promisify } from 'util'
import { AccountCredential } from '../../account-credentials/entities/account-credential'
import { AccountCredentialService } from '../../account-credentials/services/account-credentials.service'
import { IntegrationAccount } from '../../integration-accounts/entities/integration-account'
import { IntegrationAccountService } from '../../integration-accounts/services/integration-account.service'

type ProviderCallback = (err?: any, user?: any, info?: any) => void

type CustomStrategyModule = {
  Strategy?: typeof OAuth1Strategy | typeof OAuth2Strategy
  afterAuthHook?: (credentials: Record<string, string | undefined>) => Promise<Record<string, string | undefined>>
}

const requestNewAccessToken = promisify(refresh.requestNewAccessToken)

export interface ExternalAuthData {
  accessToken?: string
  refreshToken?: string
  profile: Profile
  integrationAccount: IntegrationAccount
}

interface BaseOAuthResponse {
  profile: Profile
  integrationAccount: IntegrationAccount
}

type OAuth1Response = BaseOAuthResponse & {
  type: 'oauth1'
  token: string
  tokenSecret: string
}

type OAuth2Response = BaseOAuthResponse & {
  type: 'oauth2'
  accessToken?: string
  refreshToken?: string
}

export type OAuthResponse = OAuth1Response | OAuth2Response

@Injectable()
export class OAuthStrategyFactory {
  private readonly logger = new Logger(OAuthStrategyFactory.name)
  private readonly integrationStrategies: Map<string, IntegrationAccount> = new Map()

  constructor(
    private readonly integrationAccountService: IntegrationAccountService,
    @Inject(forwardRef(() => AccountCredentialService))
    private readonly accountCredentialService: AccountCredentialService,
  ) {}

  static initializePassport(): Handler {
    passport.serializeUser(function (user, done) {
      done(null, user)
    })
    passport.deserializeUser(function (user, done) {
      done(null, user)
    })
    return passport.initialize()
  }

  /**
   * Register OAuth1/2 strategy on passport if it wasn't registered
   */
  async ensureStrategy(integrationAccountKey: string): Promise<IntegrationAccount> {
    if (!process.env.API_ENDPOINT) {
      throw new Error('Endpoint not configured')
    }

    const cachedIntegrationAccount = this.integrationStrategies.get(integrationAccountKey)
    if (cachedIntegrationAccount) {
      return cachedIntegrationAccount
    }

    this.logger.log(`Creating oauth strategy for ${integrationAccountKey}`)
    const integrationAccount = await this.integrationAccountService.findOne({ key: integrationAccountKey })
    if (!integrationAccount) {
      throw new BadRequestException(`Integration account ${integrationAccountKey} not found`)
    }

    const customStrategyClass = await this.getCustomStrategy(integrationAccount.customStrategyKey)

    switch (integrationAccount.authType) {
      case IntegrationAuthType.oauth1:
        this.registerOauth1Strategy(integrationAccountKey, integrationAccount, customStrategyClass)
        break
      case IntegrationAuthType.oauth2:
        this.registerOauth2Strategy(integrationAccountKey, integrationAccount, customStrategyClass)
        break
    }

    return integrationAccount
  }

  registerOauth1Strategy(
    integrationAccountKey: string,
    integrationAccount: IntegrationAccount,
    customStrategyClass?: CustomStrategyModule,
  ): void {
    const consumerKey = process.env[`${integrationAccount.key.toUpperCase().replace(/-/, '_')}_CONSUMER_KEY`]
    const consumerSecret = process.env[`${integrationAccount.key.toUpperCase().replace(/-/, '_')}_CONSUMER_SECRET`]
    const requestTokenURL = integrationAccount.securitySchema?.['x-requestTokenURL']
    const accessTokenURL = integrationAccount.securitySchema?.['x-accessTokenURL']
    const userAuthorizationURL = integrationAccount.securitySchema?.['x-userAuthorizationURL']
    const signatureMethod = integrationAccount.securitySchema?.['x-signatureMethod']

    if (!consumerKey || !consumerSecret) {
      this.logger.error(`Consumer key or consumer secret not defined for ${integrationAccountKey}`)
      return
    }

    if (!requestTokenURL || !accessTokenURL || !userAuthorizationURL || !signatureMethod) {
      this.logger.error(
        `requestTokenURL, accessTokenURL, userAuthorizationURL or signatureMethod not defined for ${integrationAccountKey}`,
      )
      return
    }

    passport.use(
      this.getOAuthStrategyName(integrationAccountKey),
      new (customStrategyClass?.Strategy ?? OAuth1Strategy)(
        {
          requestTokenURL,
          accessTokenURL,
          userAuthorizationURL,
          consumerKey,
          consumerSecret,
          signatureMethod,
          callbackURL: `${process.env.API_ENDPOINT}/account-credentials/oauth/${integrationAccountKey}/callback`,
        },
        (token: string, tokenSecret: string, profile: Profile, cb: ProviderCallback) => {
          cb(undefined, { type: 'oauth1', token, tokenSecret, profile, integrationAccount } as OAuth1Response)
        },
      ),
    )

    this.integrationStrategies.set(integrationAccountKey, integrationAccount)
    this.logger.log(`OAuth1 strategy for ${integrationAccountKey} created`)
  }

  registerOauth2Strategy(
    integrationAccountKey: string,
    integrationAccount: IntegrationAccount,
    customStrategyClass?: CustomStrategyModule,
  ): void {
    const authCode = integrationAccount.securitySchema?.flows?.authorizationCode
    if (authCode?.authorizationUrl && authCode.tokenUrl) {
      const credentialsKey = integrationAccount.securitySchema?.['x-credentialsKey'] ?? integrationAccount.key
      const clientId = process.env[`${credentialsKey.toUpperCase().replace(/-/, '_')}_CLIENT_ID`]
      const clientSecret = process.env[`${credentialsKey.toUpperCase().replace(/-/, '_')}_CLIENT_SECRET`]

      if (!clientId || !clientSecret) {
        this.logger.error(`Client ID or client secret not defined for ${integrationAccountKey}`)
        return
      }

      const strategyName = this.getOAuthStrategyName(integrationAccountKey)
      const strategy = new (customStrategyClass?.Strategy ?? OAuth2Strategy)(
        {
          authorizationURL: authCode.authorizationUrl,
          tokenURL: authCode.tokenUrl,
          clientID: clientId,
          clientSecret: clientSecret,
          scope: Object.keys(authCode.scopes || []),
          state: true, // adds a state random string to the authorization URL
          callbackURL: `${process.env.API_ENDPOINT}/account-credentials/oauth/${credentialsKey}/callback`,
        },
        (accessToken: string, refreshToken: string, profile: Profile, cb: ProviderCallback) => {
          cb(undefined, { type: 'oauth2', accessToken, refreshToken, profile, integrationAccount } as OAuth2Response)
        },
      )

      if (integrationAccount.authParams) {
        strategy.authorizationParams = () => integrationAccount.authParams ?? {}
      }

      passport.use(strategyName, strategy)
      refresh.use(strategyName, strategy)

      this.integrationStrategies.set(integrationAccountKey, integrationAccount)
      this.logger.log(`OAuth2 strategy for ${integrationAccountKey} created`)
    } else {
      this.logger.error(`OAuth2 missing authorizationUrl or tokenUrl for ${integrationAccountKey}`)
    }
  }

  /**
   * Gets a strategy from a custom strategy key
   * The strategy needs to be exported as default in the module
   */
  async getCustomStrategy(customStrategyKey: string | undefined): Promise<CustomStrategyModule | undefined> {
    if (!customStrategyKey) {
      return
    }
    const { Strategy, afterAuthHook } = await import(`./integration-strategies/${customStrategyKey}-auth`)
    return { Strategy, afterAuthHook }
  }

  async refreshOauth2AccessToken(
    integrationAccountKey: string,
    accountCredential: AccountCredential | null,
    credentials: Record<string, any>,
  ): Promise<string> {
    this.logger.log(`Refreshing access token for "${integrationAccountKey}" - user ${accountCredential?.owner}`)
    await this.ensureStrategy(integrationAccountKey)
    try {
      credentials.accessToken = (await requestNewAccessToken(
        this.getOAuthStrategyName(integrationAccountKey),
        credentials.refreshToken,
      )) as string
    } catch (e) {
      this.logger.error(
        `Failed to refresh access token for "${integrationAccountKey}" - user ${accountCredential?.owner}`,
      )
      throw e
    }
    if (accountCredential) {
      await this.accountCredentialService.updateOne(accountCredential.id, { credentialInputs: credentials })
    }
    return credentials.accessToken
  }

  getOAuthStrategyName(integrationAccountKey: string): string {
    return `integration-${integrationAccountKey}`
  }
}
