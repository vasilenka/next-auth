import { createHash, randomBytes } from 'crypto'
import jwt from '../lib/jwt'
import cookie from './lib/cookie'
import callbackUrlHandler from './lib/callback-url-handler'
import parseProviders from './lib/providers'
import events from './lib/events'
import callbacks from './lib/callbacks'
import providers from './routes/providers'
import signin from './routes/signin'
import signout from './routes/signout'
import callback from './routes/callback'
import session from './routes/session'
import pages from './pages'
import adapters from '../adapters'

const DEFAULT_SITE = 'http://localhost:3000'
const DEFAULT_BASE_PATH = '/api/auth'

export default async (req, res, userSuppliedOptions) => {
  // To the best of my knowledge, we need to return a promise here
  // to avoid early termination of calls to the serverless function
  // (and then return that promise when we are done) - eslint
  // complains but I'm not sure there is another way to do this.
  return new Promise(async resolve => { // eslint-disable-line no-async-promise-executor
    // This is passed to all methods that handle responses, and must be called
    // when they are complete so that the serverless function knows when it is
    // safe to return and that no more data will be sent.
    const done = resolve

    const { url, query, body } = req
    const {
      nextauth,
      action = nextauth[0],
      provider = nextauth[1],
      error = nextauth[1]
    } = query

    const {
      csrfToken: csrfTokenFromPost
    } = body

    // Allow site name, path prefix to be overriden
    const site = userSuppliedOptions.site || DEFAULT_SITE
    const basePath = userSuppliedOptions.basePath || DEFAULT_BASE_PATH
    const baseUrl = `${site}${basePath}`

    // Parse database / adapter
    let adapter
    if (userSuppliedOptions.adapter) {
      // If adapter is provided, use it (advanced usage, overrides database)
      adapter = userSuppliedOptions.adapter
    } else if (userSuppliedOptions.database) {
      // If database URI or config object is provided, use it (simple usage)
      adapter = adapters.Default(userSuppliedOptions.database)
    }

    // Secret used salt cookies and tokens (e.g. for CSRF protection).
    // If no secret option is specified then it creates one on the fly
    // based on options passed here. A options contains unique data, such as
    // oAuth provider secrets and database credentials it should be sufficent.
    const secret = userSuppliedOptions.secret || createHash('sha256').update(JSON.stringify(userSuppliedOptions)).digest('hex')

    // Use secure cookies if the site uses HTTPS
    // This being conditional allows cookies to work non-HTTPS development URLs
    // Honour secure cookie option, which sets 'secure' and also adds '__Secure-'
    // prefix, but enable them by default if the site URL is HTTPS; but not for
    // non-HTTPS URLs like http://localhost which are used in development).
    // For more on prefixes see https://googlechrome.github.io/samples/cookie-prefixes/
    const useSecureCookies = userSuppliedOptions.useSecureCookies || baseUrl.startsWith('https://')
    const cookiePrefix = useSecureCookies ? '__Secure-' : ''

    // @TODO Review cookie settings (names, options)
    const cookies = {
      // default cookie options
      sessionToken: {
        name: `${cookiePrefix}next-auth.session-token`,
        options: {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          secure: useSecureCookies
        }
      },
      callbackUrl: {
        name: `${cookiePrefix}next-auth.callback-url`,
        options: {
          sameSite: 'lax',
          path: '/',
          secure: useSecureCookies
        }
      },
      csrfToken: {
        // Default to __Host- for CSRF token for additional protection if using useSecureCookies
        // NB: The `__Host-` prefix is stricter than the `__Secure-` prefix.
        name: `${useSecureCookies ? '__Host-' : ''}next-auth.csrf-token`,
        options: {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          secure: useSecureCookies
        }
      },
      // Allow user cookie options to override any cookie settings above
      ...userSuppliedOptions.cookies
    }

    // Session options
    const sessionOption = {
      jwt: false,
      maxAge: 30 * 24 * 60 * 60, // Sessions expire after 30 days of being idle
      updateAge: 24 * 60 * 60, // Sessions updated only if session is greater than this value (0 = always, 24*60*60 = every 24 hours)
      ...userSuppliedOptions.session
    }

    // JWT options
    const jwtOptions = {
      secret,
      key: secret,
      encode: jwt.encode,
      decode: jwt.decode,
      ...userSuppliedOptions.jwt
    }

    // If no adapter specified, force use of JSON Web Tokens (stateless)
    if (!adapter) {
      sessionOption.jwt = true
    }

    // Event messages
    const eventsOption = {
      ...events,
      ...userSuppliedOptions.events
    }

    // Callback functions
    const callbacksOption = {
      ...callbacks,
      ...userSuppliedOptions.callbacks
    }

    // Ensure CSRF Token cookie is set for any subsequent requests.
    // Used as part of the strateigy for mitigation for CSRF tokens.
    //
    // Creates a cookie like 'next-auth.csrf-token' with the value 'token|hash',
    // where 'token' is the CSRF token and 'hash' is a hash made of the token and
    // the secret, and the two values are joined by a pipe '|'. By storing the
    // value and the hash of the value (with the secret used as a salt) we can
    // verify the cookie was set by the server and not by a malicous attacker.
    //
    // For more details, see the following OWASP links:
    // https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#double-submit-cookie
    // https://owasp.org/www-chapter-london/assets/slides/David_Johansson-Double_Defeat_of_Double-Submit_Cookie.pdf
    let csrfToken
    let csrfTokenVerified = false
    if (req.cookies[cookies.csrfToken.name]) {
      const [csrfTokenValue, csrfTokenHash] = req.cookies[cookies.csrfToken.name].split('|')
      if (csrfTokenHash === createHash('sha256').update(`${csrfTokenValue}${secret}`).digest('hex')) {
        // If hash matches then we trust the CSRF token value
        csrfToken = csrfTokenValue

        // If this is a POST request and the CSRF Token in the Post request matches
        // the cookie we have already verified is one we have set, then token is verified!
        if (req.method === 'POST' && csrfToken === csrfTokenFromPost) { csrfTokenVerified = true }
      }
    }
    if (!csrfToken) {
      // If no csrfToken - because it's not been set yet, or because the hash doesn't match
      // (e.g. because it's been modifed or because the secret has changed) create a new token.
      csrfToken = randomBytes(32).toString('hex')
      const newCsrfTokenCookie = `${csrfToken}|${createHash('sha256').update(`${csrfToken}${secret}`).digest('hex')}`
      cookie.set(res, cookies.csrfToken.name, newCsrfTokenCookie, cookies.csrfToken.options)
    }

    // User provided options are overriden by other options,
    // except for the options with special handling above
    const options = {
      // Defaults options can be overidden
      debug: false, // Enable debug messages to be displayed
      pages: {}, // Custom pages (e.g. sign in, sign out, errors)
      // Custom options override defaults
      ...userSuppliedOptions,
      // These computed settings can values in userSuppliedOptions but override them
      // and are request-specific.
      adapter,
      site,
      basePath,
      baseUrl,
      action,
      provider,
      cookies,
      secret,
      csrfToken,
      csrfTokenVerified,
      providers: parseProviders(userSuppliedOptions.providers, baseUrl),
      session: sessionOption,
      jwt: jwtOptions,
      events: eventsOption,
      callbacks: callbacksOption,
      callbackUrl: site
    }

    // If debug enabled, set ENV VAR so that logger logs debug messages
    if (options.debug === true) { process.env._NEXTAUTH_DEBUG = true }

    // Get / Set callback URL based on query param / cookie + validation
    options.callbackUrl = await callbackUrlHandler(req, res, options)

    const redirect = (redirectUrl) => {
      res.status(302).setHeader('Location', redirectUrl)
      res.end()
      return done()
    }

    if (req.method === 'GET') {
      switch (action) {
        case 'providers':
          providers(req, res, options, done)
          break
        case 'session':
          session(req, res, options, done)
          break
        case 'csrf':
          res.json({ csrfToken })
          return done()
        case 'signin':
          if (provider && options.providers[provider]) {
            signin(req, res, options, done)
          } else {
            if (options.pages.signin) { return redirect(`${options.pages.signin}${options.pages.signin.includes('?') ? '&' : '?'}callbackUrl=${options.callbackUrl}`) }

            pages.render(req, res, 'signin', { site, providers: Object.values(options.providers), callbackUrl: options.callbackUrl, csrfToken }, done)
          }
          break
        case 'signout':
          if (options.pages.signout) { return redirect(`${options.pages.signout}${options.pages.signout.includes('?') ? '&' : '?'}callbackUrl=${options.callbackUrl}`) }

          pages.render(req, res, 'signout', { site, baseUrl, csrfToken, callbackUrl: options.callbackUrl }, done)
          break
        case 'callback':
          if (provider && options.providers[provider]) {
            callback(req, res, options, done)
          } else {
            res.status(400).end(`Error: HTTP GET is not supported for ${url}`)
            return done()
          }
          break
        case 'verify-request':
          if (options.pages.verifyRequest) { return redirect(options.pages.verifyRequest) }

          pages.render(req, res, 'verify-request', { site }, done)
          break
        case 'error':
          if (options.pages.error) { return redirect(`${options.pages.error}${options.pages.error.includes('?') ? '&' : '?'}error=${error}`) }

          pages.render(req, res, 'error', { site, error, baseUrl }, done)
          break
        default:
          res.status(404).end()
          return done()
      }
    } else if (req.method === 'POST') {
      switch (action) {
        case 'signin':
          // Signin POST requests are used for email sign in
          if (provider && options.providers[provider]) {
            signin(req, res, options, done)
            break
          }
          break
        case 'signout':
          signout(req, res, options, done)
          break
        case 'callback':
          if (provider && options.providers[provider]) {
            callback(req, res, options, done)
          } else {
            res.status(400).end(`Error: HTTP POST is not supported for ${url}`)
            return done()
          }
          break
        default:
          res.status(400).end(`Error: HTTP POST is not supported for ${url}`)
          return done()
      }
    } else {
      res.status(400).end(`Error: HTTP ${req.method} is not supported for ${url}`)
      return done()
    }
  })
}
