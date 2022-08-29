import type {
  CallbackState,
  CallbackStorage,
  KeycloakAdapter,
  KeycloakConfig,
  KeycloakEndpoints,
  KeycloakError,
  KeycloakFlow,
  KeycloakInitOptions,
  KeycloakInstance,
  KeycloakLoginOptions,
  KeycloakLogoutOptions,
  KeycloakPkceMethod,
  KeycloakProfile,
  KeycloakRegisterOptions,
  KeycloakResourceAccess,
  KeycloakResponseMode,
  KeycloakResponseType,
  KeycloakRoles,
  KeycloakTokenParsed,
  OAuthResponse,
} from './types';

import Deferred from './utils/deferred';

import {
  decodeToken,
  getRealmUrl,
  isKeycloakConfig,
  setupOidcEndoints,
  parseCallbackParams,
} from './utils/keycloak';

import { formatQuerystringParameters } from './utils/url';

import {
  createUUID,
  generateCodeVerifier,
  generatePkceChallenge,
} from './utils/uuid';

/**
 * A client for the Keycloak authentication server.
 * @see {@link https://keycloak.gitbooks.io/securing-client-applications-guide/content/topics/oidc/javascript-adapter.html|Keycloak JS adapter documentation}
 */
export class KeycloakClient implements KeycloakInstance {
  authenticated?: boolean;

  subject?: string;

  responseMode?: KeycloakResponseMode;

  responseType?: KeycloakResponseType;

  flow?: KeycloakFlow;

  realmAccess?: KeycloakRoles;

  resourceAccess?: KeycloakResourceAccess;

  token?: string;

  tokenParsed?: KeycloakTokenParsed;

  refreshToken?: string;

  refreshTokenParsed?: KeycloakTokenParsed;

  idToken?: string;

  idTokenParsed?: KeycloakTokenParsed;

  timeSkew?: number;

  loginRequired?: boolean;

  authServerUrl?: string;

  realm?: string;

  clientId?: string;

  redirectUri?: string;

  profile?: KeycloakProfile;

  userInfo?: unknown; // KeycloakUserInfo;

  enableLogging?: boolean;

  tokenTimeoutHandle?: NodeJS.Timeout | null;

  endpoints?: KeycloakEndpoints;

  clientConfig: KeycloakConfig;

  private adapter?: KeycloakAdapter;

  private callbackStorage?: CallbackStorage;

  private logInfo = this.createLogger(console.info);

  private logWarn = this.createLogger(console.warn);

  private refreshQueue: Array<Deferred<boolean>> = [];

  private useNonce?: boolean;

  private pkceMethod?: KeycloakPkceMethod;

  constructor(clientConfig: KeycloakConfig) {
    this.clientConfig = clientConfig;
  }

  /**
   * Called to initialize the adapter.
   * @param initOptions Initialization options.
   * @returns A promise to set functions to be invoked on success or error.
   */
  public async init(initOptions: KeycloakInitOptions): Promise<boolean> {
    this.authenticated = false;

    if (!initOptions.adapter) {
      throw new Error('Missing Keycloak adapter from initOptions');
    }

    this.adapter = new initOptions.adapter(
      this,
      this.clientConfig,
      initOptions
    );

    this.callbackStorage = this.adapter.createCallbackStorage();

    if (initOptions) {
      if (typeof initOptions.useNonce !== 'undefined') {
        this.useNonce = initOptions.useNonce;
      }

      if (initOptions.onLoad === 'login-required') {
        this.loginRequired = true;
      }

      if (initOptions.responseMode) {
        if (
          initOptions.responseMode === 'query' ||
          initOptions.responseMode === 'fragment'
        ) {
          this.responseMode = initOptions.responseMode;
        } else {
          throw new Error('Invalid value for responseMode');
        }
      }

      if (initOptions.flow) {
        switch (initOptions.flow) {
          case 'standard':
            this.responseType = 'code';
            break;

          case 'implicit':
            this.responseType = 'id_token token';
            break;

          case 'hybrid':
            this.responseType = 'code id_token token';
            break;

          default:
            throw new Error('Invalid value for flow');
        }

        this.flow = initOptions.flow;
      }

      if (initOptions.timeSkew != null) {
        this.timeSkew = initOptions.timeSkew;
      }

      if (initOptions.redirectUri) {
        this.redirectUri = initOptions.redirectUri;
      }

      if (initOptions.pkceMethod) {
        if (initOptions.pkceMethod !== 'S256') {
          throw new Error('Invalid value for pkceMethod');
        }
        this.pkceMethod = initOptions.pkceMethod;
      }

      if (typeof initOptions.enableLogging === 'boolean') {
        this.enableLogging = initOptions.enableLogging;
      } else {
        this.enableLogging = false;
      }
    }

    if (!this.responseMode) {
      this.responseMode = 'fragment';
    }

    if (!this.responseType) {
      this.responseType = 'code';
      this.flow = 'standard';
    }

    await this.loadConfig(this.clientConfig);

    // await check3pCookiesSupported(); // Not supported on RN

    await this.processInit(initOptions);

    // Notify onReady event handler if set
    this.onReady && this.onReady(this.authenticated);

    // Return authentication status
    return this.authenticated;
  }

  /**
   * Redirects to login form.
   * @param username  Username
   * @param password  Password
   * @param scope     (Optional) Scope
   */
  public async loginWithPasswordGrant(
    username: string,
    password: string,
    scope?: string
  ): Promise<void> {
    return this.adapter!.loginWithPasswordGrant(username, password, scope);
  }

  /**
   * login with password grant.
   * @param options Login options.
   */
  public async login(options?: KeycloakLoginOptions): Promise<void> {
    return this.adapter!.login(options);
  }

  /**
   * Redirects to logout.
   * @param options Logout options.
   */
  public async logout(options?: KeycloakLogoutOptions): Promise<void> {
    return this.adapter!.logout(options);
  }

  /**
   * Redirects to registration form.
   * @param options The options used for the registration.
   */
  public async register(options?: KeycloakRegisterOptions): Promise<void> {
    return this.adapter!.register(options);
  }

  /**
   * Redirects to the Account Management Console.
   */
  public async accountManagement(): Promise<void> {
    return this.adapter!.accountManagement();
  }

  /**
   * Returns the URL to login form.
   * @param options Supports same options as Keycloak#login.
   */
  public createLoginUrl(options?: KeycloakLoginOptions): string {
    const state = createUUID();
    const nonce = createUUID();

    const redirectUri = this.adapter!.redirectUri(options);
    const {
      scope: scopeOption,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      redirectUri: redirectUriOption,
      prompt,
      action,
      maxAge,
      loginHint,
      idpHint,
      locale,
      ...rest
    } = options ?? {};

    let codeVerifier;
    let pkceChallenge;
    if (this.pkceMethod) {
      codeVerifier = generateCodeVerifier(96);
      pkceChallenge = generatePkceChallenge(this.pkceMethod, codeVerifier);
    }

    const callbackState: CallbackState = {
      state,
      nonce,
      pkceCodeVerifier: codeVerifier,
      prompt: options?.prompt ?? undefined,
      redirectUri,
    };

    let scope;
    if (scopeOption) {
      if (scopeOption.indexOf('openid') !== -1) {
        scope = scopeOption;
      } else {
        scope = 'openid ' + scopeOption;
      }
    } else {
      scope = 'openid';
    }

    const baseUrl =
      action === 'register'
        ? this.endpoints!.register()
        : this.endpoints!.authorize();

    const params = new Map<string, string>();
    params.set('client_id', this.clientId!);
    params.set('redirect_uri', redirectUri);
    params.set('state', state);
    params.set('response_mode', this.responseMode!);
    params.set('response_type', this.responseType!);
    params.set('scope', scope);

    if (this.useNonce) {
      params.set('nonce', nonce);
    }

    if (prompt) {
      params.set('prompt', prompt);
    }

    if (maxAge) {
      params.set('max_age', `${maxAge}`);
    }

    if (loginHint) {
      params.set('login_hint', loginHint);
    }

    if (idpHint) {
      params.set('kc_idp_hint', idpHint);
    }

    if (action && action !== 'register') {
      params.set('kc_action', action);
    }

    if (locale) {
      params.set('ui_locales', locale);
    }

    if (this?.pkceMethod && !!pkceChallenge) {
      params.set('code_challenge', pkceChallenge);
      params.set('code_challenge_method', this.pkceMethod);
    }

    this.callbackStorage!.add(callbackState);

    Object.keys(rest).forEach(key => {
      params.set(key, `${rest[key]}`);
    });

    return `${baseUrl}?${formatQuerystringParameters(params)}`;
  }

  /**
   * Returns the URL to logout the user.
   * @param options Logout options.
   */
  public createLogoutUrl(options?: KeycloakLogoutOptions): string {
    const params = new Map<string, string>();
    params.set('redirect_uri', this.adapter!.redirectUri(options));

    return `${this.endpoints!.logout()}?${formatQuerystringParameters(params)}`;
  }

  /**
   * Returns the URL to registration page.
   * @param options The options used for creating the registration URL.
   */
  public createRegisterUrl(options: KeycloakRegisterOptions = {}): string {
    return this.createLoginUrl({
      ...options,
      action: 'register',
    });
  }

  /**
   * Returns the URL to the Account Management Console.
   */
  public createAccountUrl(): string {
    const realm = getRealmUrl(this.realm!, this.authServerUrl);
    if (typeof realm === 'undefined') {
      throw new Error('Failed to create Account URL. realm is not defined.');
    }

    const params = new Map<string, string>();
    params.set('referrer', this.clientId!);
    params.set('referrer_uri', this.adapter!.redirectUri());

    return `${realm}/account?${formatQuerystringParameters(params)}`;
  }

  /**
   * Returns true if the token has less than `minValidity` seconds left before
   * it expires.
   * @param minValidity If not specified, `0` is used.
   */
  public isTokenExpired(minValidity?: number): boolean {
    if (!this.tokenParsed || (!this.refreshToken && this.flow !== 'implicit')) {
      throw 'Not authenticated';
    }

    if (this.timeSkew == null) {
      this.logInfo(
        '[KEYCLOAK] Unable to determine if token is expired as timeskew is not set'
      );
      return true;
    }

    let expiresIn =
      (this.tokenParsed?.exp ?? 0) -
      Math.ceil(new Date().getTime() / 1000) +
      this.timeSkew;

    if (minValidity) {
      if (isNaN(minValidity)) {
        throw 'Invalid minValidity';
      }

      expiresIn -= minValidity;
    }

    return expiresIn < 0;
  }

  private async runUpdateToken(
    minValidity: number,
    deffered: Deferred<boolean>
  ) {
    let shouldRefreshToken: boolean = false;

    if (minValidity === -1) {
      shouldRefreshToken = true;
      this.logInfo('[KEYCLOAK] Refreshing token: forced refresh');
    } else if (!this.tokenParsed || this.isTokenExpired(minValidity)) {
      shouldRefreshToken = true;
      this.logInfo('[KEYCLOAK] Refreshing token: token expired');
    }

    if (!shouldRefreshToken) {
      deffered.resolve(false);
    } else {
      const tokenUrl = this.endpoints!.token();

      const params = new Map<string, string>();
      params.set('client_id', this.clientId!);
      params.set('grant_type', 'refresh_token');
      params.set('refresh_token', this.refreshToken!);

      this.refreshQueue.push(deffered);

      if (this.refreshQueue.length === 1) {
        let timeLocal = new Date().getTime();

        try {
          const tokenResponse = await this.adapter!.refreshTokens(
            tokenUrl,
            formatQuerystringParameters(params)
          );

          if (tokenResponse.error) {
            this.clearToken();
            throw new Error(tokenResponse.error);
          } else {
            this.logInfo('[KEYCLOAK] Token refreshed');

            timeLocal = (timeLocal + new Date().getTime()) / 2;

            this.setToken(
              tokenResponse.access_token,
              tokenResponse.refresh_token,
              tokenResponse.id_token,
              timeLocal
            );

            // Notify onAuthRefreshSuccess event handler if set
            this.onAuthRefreshSuccess && this.onAuthRefreshSuccess();

            for (
              let p = this.refreshQueue.pop();
              p != null;
              p = this.refreshQueue.pop()
            ) {
              p.resolve(true);
            }
          }
        } catch (err) {
          this.logWarn('[KEYCLOAK] Failed to refresh token');

          // Notify onAuthRefreshError event handler if set
          this.onAuthRefreshError && this.onAuthRefreshError();

          for (
            let p = this.refreshQueue.pop();
            p != null;
            p = this.refreshQueue.pop()
          ) {
            p.reject(true);
          }
        }
      }
    }
  }

  /**
   * If the token expires within `minValidity` seconds, the token is refreshed.
   * If the session status iframe is enabled, the session status is also
   * checked.
   * @returns A promise to set functions that can be invoked if the token is
   *          still valid, or if the token is no longer valid.
   * @example
   * ```js
   * keycloak.updateToken(5).then(function(refreshed) {
   *   if (refreshed) {
   *     alert('Token was successfully refreshed');
   *   } else {
   *     alert('Token is still valid');
   *   }
   * }).catch(function() {
   *   alert('Failed to refresh the token, or the session has expired');
   * });
   */
  public async updateToken(minValidity: number = 5): Promise<boolean> {
    const deffered = new Deferred<boolean>();

    if (!this.refreshToken) {
      deffered.reject('missing refreshToken');
      return deffered.getPromise();
    }

    this.runUpdateToken(minValidity, deffered);

    return deffered.getPromise();
  }

  /**
   * Clears authentication state, including tokens. This can be useful if
   * the application has detected the session was expired, for example if
   * updating token fails. Invoking this results in Keycloak#onAuthLogout
   * callback listener being invoked.
   */
  public clearToken(): void {
    if (this.token) {
      this.setToken(null, null, null);

      // Notify onAuthLogout event handler if set
      this.onAuthLogout && this.onAuthLogout();

      if (this.loginRequired) {
        this.login();
      }
    }
  }

  /**
   * Returns true if the token has the given realm role.
   * @param role A realm role name.
   */
  public hasRealmRole(role: string): boolean {
    return !!this.realmAccess && this.realmAccess.roles?.indexOf(role) >= 0;
  }

  /**
   * Returns true if the token has the given role for the resource.
   * @param role A role name.
   * @param resource If not specified, `clientId` is used.
   */
  public hasResourceRole(role: string, resource?: string): boolean {
    if (!this.resourceAccess) {
      return false;
    }

    const access = this.resourceAccess[resource || this.clientId || ''];
    return !!access && access.roles.indexOf(role) >= 0;
  }

  /**
   * Loads the user's profile.
   *
   * @returns The current user KeycloakProfile.
   */
  async loadUserProfile(): Promise<KeycloakProfile> {
    const profileUrl =
      getRealmUrl(this.realm!, this.authServerUrl) + '/account';

    const userProfileRes = await this.adapter!.fetchUserProfile(
      profileUrl,
      this.token!
    );

    this.profile = userProfileRes;
    return this.profile;
  }

  /**
   * @private Undocumented.
   */
  async loadUserInfo(): Promise<unknown> {
    const userInfoUrl = this.endpoints!.userinfo();

    const userInfoRes = await this.adapter!.fetchUserInfo(
      userInfoUrl,
      this.token!
    );

    this.userInfo = userInfoRes;
    return this.userInfo;
  }

  /**
   * Called when the adapter is initialized.
   */
  onReady?(authenticated?: boolean): void;

  /**
   * Called when a user is successfully authenticated.
   */
  onAuthSuccess?(): void;

  /**
   * Called if there was an error during authentication.
   */
  onAuthError?(errorData: KeycloakError): void;

  /**
   * Called when the token is refreshed.
   */
  onAuthRefreshSuccess?(): void;

  /**
   * Called if there was an error while trying to refresh the token.
   */
  onAuthRefreshError?(): void;

  /**
   * Called if the user is logged out (will only be called if the session
   * status iframe is enabled, or in Cordova mode).
   */
  onAuthLogout?(): void;

  /**
   * Called when the access token is expired. If a refresh token is available
   * the token can be refreshed with Keycloak#updateToken, or in cases where
   * it's not (ie. with implicit flow) you can redirect to login screen to
   * obtain a new access token.
   */
  onTokenExpired?(): void;

  /**
   * Called when a AIA has been requested by the application.
   */
  onActionUpdate?(status: 'success' | 'cancelled' | 'error'): void;

  /**
   * @private Undocumented.
   */
  async processCallback(oauth: OAuthResponse) {
    const timeLocal = new Date().getTime();

    if (oauth.kc_action_status) {
      this.onActionUpdate && this.onActionUpdate(oauth.kc_action_status);
    }

    const { code, error, prompt } = oauth;

    if (error) {
      if (prompt !== 'none') {
        this.onAuthError &&
          this.onAuthError({
            error,
            error_description: oauth.error_description ?? 'auth error',
          });

        throw new Error(oauth.error_description);
      }

      return;
    }

    if (this.flow !== 'standard' && (oauth.access_token || oauth.id_token)) {
      return this.authSuccess(oauth, timeLocal, true);
    }

    if (this.flow !== 'implicit' && code) {
      const params = new Map<string, string>();
      params.set('code', code);
      params.set('grant_type', 'authorization_code');
      params.set('client_id', this.clientId!);
      params.set('redirect_uri', oauth.redirectUri!);

      if (oauth.pkceCodeVerifier) {
        params.set('code_verifier', oauth.pkceCodeVerifier);
      }

      const tokenUrl = this.endpoints!.token();
      try {
        const tokenResponse = await this.adapter!.fetchTokens(
          tokenUrl,
          formatQuerystringParameters(params)
        );

        await this.authSuccess(
          {
            ...oauth,
            access_token: tokenResponse.access_token || undefined,
            refresh_token: tokenResponse.refresh_token || undefined,
            id_token: tokenResponse.id_token || undefined,
          },
          timeLocal,
          this.flow === 'standard'
        );
      } catch (err) {
        // Notify onAuthError event handler if set
        this.onAuthError &&
          this.onAuthError({
            error: err,
            error_description:
              'Failed to refresh token during callback processing',
          });

        throw new Error(err);
      }
    }
  }

  private async authSuccess(
    oauthObj: OAuthResponse,
    timeLocal: number,
    fulfillPromise: boolean
  ) {
    timeLocal = (timeLocal + new Date().getTime()) / 2;

    this.setToken(
      oauthObj.access_token ?? null,
      oauthObj.refresh_token ?? null,
      oauthObj.id_token ?? null,
      timeLocal
    );

    if (
      this.useNonce &&
      ((this.tokenParsed && this.tokenParsed.nonce !== oauthObj.storedNonce) ||
        (this.refreshTokenParsed &&
          this.refreshTokenParsed.nonce !== oauthObj.storedNonce) ||
        (this.idTokenParsed &&
          this.idTokenParsed.nonce !== oauthObj.storedNonce))
    ) {
      this.logInfo('[KEYCLOAK] Invalid nonce, clearing token');
      this.clearToken();

      throw new Error('invalid nonce, token cleared');
    }

    if (fulfillPromise) {
      this.onAuthSuccess && this.onAuthSuccess();
    }
  }

  /**
   * @private Undocumented.
   */
  parseCallback(url: string): OAuthResponse {
    const oauthParsed = this.parseCallbackUrl(url);
    if (!oauthParsed) {
      throw new Error('Failed to parse redirect URL');
    }

    const oauthState = this.callbackStorage!.get(oauthParsed.state as string);

    if (oauthState) {
      return {
        ...oauthParsed,
        valid: true,
        redirectUri: oauthState.redirectUri,
        storedNonce: oauthState.nonce,
        prompt: oauthState.prompt,
        pkceCodeVerifier: oauthState.pkceCodeVerifier,
      };
    }

    return oauthParsed as OAuthResponse;
  }

  private async processInit(initOptions?: KeycloakInitOptions): Promise<void> {
    if (initOptions) {
      if (initOptions.token && initOptions.refreshToken) {
        this.setToken(
          initOptions.token,
          initOptions.refreshToken,
          initOptions.idToken ?? null
        );

        try {
          await this.updateToken(-1);

          // Notify onAuthSuccess event handler if set
          this.onAuthSuccess && this.onAuthSuccess();
        } catch (error) {
          // Notify onAuthError event handler if set
          this.onAuthError &&
            this.onAuthError({
              error,
              error_description: 'Failed to refresh token during init',
            });

          if (initOptions.onLoad) {
            this.onLoad(initOptions);
          } else {
            throw new Error('Failed to init');
          }
        }
        // }
      } else if (initOptions.onLoad) {
        this.onLoad(initOptions);
      }
    }
  }

  private async onLoad(initOptions: KeycloakInitOptions): Promise<void> {
    switch (initOptions.onLoad) {
      case 'login-required':
        this.doLogin(initOptions, true);
        break;

      case 'check-sso':
        break;

      default:
        throw new Error('Invalid value for onLoad');
    }
  }

  private async doLogin(
    initOptions: KeycloakInitOptions,
    prompt?: boolean
  ): Promise<void> {
    return this.login({
      ...initOptions,
      prompt: !prompt ? 'none' : undefined,
    });
  }

  public setToken(
    token: string | null,
    refreshToken: string | null,
    idToken: string | null,
    timeLocal?: number
  ) {
    if (this.tokenTimeoutHandle) {
      clearTimeout(this.tokenTimeoutHandle);
      this.tokenTimeoutHandle = null;
    }

    if (refreshToken) {
      this.refreshToken = refreshToken;
      this.refreshTokenParsed = decodeToken(refreshToken);
    } else {
      delete this.refreshToken;
      delete this.refreshTokenParsed;
    }

    if (idToken) {
      this.idToken = idToken;
      this.idTokenParsed = decodeToken(idToken);
    } else {
      delete this.idToken;
      delete this.idTokenParsed;
    }

    if (token) {
      this.token = token;
      this.tokenParsed = decodeToken(token);
      if (!this.tokenParsed) {
        throw new Error('Invalid tokenParsed');
      }

      this.authenticated = true;
      this.subject = this.tokenParsed.sub;
      this.realmAccess = this.tokenParsed.realm_access;
      this.resourceAccess = this.tokenParsed.resource_access;

      if (timeLocal) {
        this.timeSkew =
          Math.floor(timeLocal / 1000) - (this.tokenParsed.iat ?? 0);
      }

      if (this.timeSkew != null) {
        this.logInfo(
          `[KEYCLOAK] Estimated time difference between browser and server is ${this.timeSkew} seconds`
        );

        if (this.onTokenExpired) {
          const expiresIn =
            ((this.tokenParsed.exp ?? 0) -
              new Date().getTime() / 1000 +
              this.timeSkew) *
            1000;

          this.logInfo(
            `[KEYCLOAK] Token expires in ${Math.round(expiresIn / 1000)} s`
          );

          if (expiresIn <= 0) {
            this.onTokenExpired();
          } else {
            this.tokenTimeoutHandle = setTimeout(
              this.onTokenExpired,
              expiresIn
            );
          }
        }
      }
    } else {
      delete this.token;
      delete this.tokenParsed;
      delete this.subject;
      delete this.realmAccess;
      delete this.resourceAccess;

      this.authenticated = false;
    }
  }

  private createLogger(fn: (...optionalParams: unknown[]) => void): Function {
    return () => {
      if (this.enableLogging) {
        fn.apply(console, Array.prototype.slice.call(arguments));
      }
    };
  }

  private async loadConfig(config?: KeycloakConfig | string): Promise<void> {
    let configUrl;
    if (!config) {
      configUrl = 'keycloak.json';
    } else if (typeof config === 'string') {
      configUrl = config;
    }

    if (configUrl) {
      const configJSON = await this.adapter!.fetchKeycloakConfigJSON(configUrl);

      this.realm = configJSON.realm;
      this.clientId = configJSON.resource;

      this.endpoints = setupOidcEndoints({
        realm: this.realm,
        authServerUrl: this.authServerUrl,
      });

      return;
    }

    if (!isKeycloakConfig(config)) {
      throw new Error('invalid configuration format');
    }

    if (!config.clientId) {
      throw new Error('clientId missing from configuration');
    }

    this.clientId = config.clientId;

    const oidcProvider = config.oidcProvider;
    // When oidcProvider config is not supplied, use local configuration params
    if (!oidcProvider) {
      if (!config.realm) {
        throw new Error('realm missing from configuration');
      }

      this.realm = config.realm;
      this.authServerUrl = config.url;

      this.endpoints = setupOidcEndoints({
        realm: this.realm,
        authServerUrl: this.authServerUrl,
      });

      return;
    }

    // When oidcProvider config is a string, load the config from the URL
    if (typeof oidcProvider === 'string') {
      let oidcProviderConfigUrl;
      if (oidcProvider.charAt(oidcProvider.length - 1) === '/') {
        oidcProviderConfigUrl =
          oidcProvider + '.well-known/openid-configuration';
      } else {
        oidcProviderConfigUrl =
          oidcProvider + '/.well-known/openid-configuration';
      }

      try {
        const oidcProviderConfig =
          await this.adapter!.fetchOIDCProviderConfigJSON(
            oidcProviderConfigUrl
          );

        this.endpoints = setupOidcEndoints({
          oidcConfiguration: oidcProviderConfig,
        });

        return;
      } catch (err) {
        throw err;
      }
    }

    // Otherwise oidcProvider is a config object and should be used
    this.endpoints = setupOidcEndoints({
      oidcConfiguration: oidcProvider,
    });
  }

  private parseCallbackUrl(url: string) {
    let supportedParams: string[] = [];
    switch (this.flow) {
      case 'standard':
        supportedParams = [
          'code',
          'state',
          'session_state',
          'kc_action_status',
        ];
        break;

      case 'implicit':
        supportedParams = [
          'access_token',
          'token_type',
          'id_token',
          'state',
          'session_state',
          'expires_in',
          'kc_action_status',
        ];
        break;

      case 'hybrid':
        supportedParams = [
          'access_token',
          'id_token',
          'code',
          'state',
          'session_state',
          'kc_action_status',
        ];
        break;
    }

    supportedParams.push('error');
    supportedParams.push('error_description');
    supportedParams.push('error_uri');

    const queryIndex = url.indexOf('?');
    const fragmentIndex = url.indexOf('#');

    let newUrl: string;
    let parsed;

    if (this.responseMode === 'query' && queryIndex !== -1) {
      newUrl = url.substring(0, queryIndex);
      parsed = parseCallbackParams(
        url.substring(
          queryIndex + 1,
          fragmentIndex !== -1 ? fragmentIndex : url.length
        ),
        supportedParams
      );
      if (parsed.paramsString !== '') {
        newUrl += '?' + parsed.paramsString;
      }
      if (fragmentIndex !== -1) {
        newUrl += url.substring(fragmentIndex);
      }
    } else if (this.responseMode === 'fragment' && fragmentIndex !== -1) {
      newUrl = url.substring(0, fragmentIndex);
      parsed = parseCallbackParams(
        url.substring(fragmentIndex + 1),
        supportedParams
      );
      if (parsed.paramsString !== '') {
        newUrl += '#' + parsed.paramsString;
      }
    }

    if (parsed && parsed.oauthParams) {
      if (this.flow === 'standard' || this.flow === 'hybrid') {
        if (
          (parsed.oauthParams.code || parsed.oauthParams.error) &&
          parsed.oauthParams.state
        ) {
          parsed.oauthParams.newUrl = newUrl!;
          return parsed.oauthParams;
        }
      } else if (this.flow === 'implicit') {
        if (
          (parsed.oauthParams.access_token || parsed.oauthParams.error) &&
          parsed.oauthParams.state
        ) {
          parsed.oauthParams.newUrl = newUrl!;
          return parsed.oauthParams;
        }
      }
    }

    return {};
  }
}
