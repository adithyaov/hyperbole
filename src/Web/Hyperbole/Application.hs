{-# LANGUAGE LambdaCase #-}
{-# LANGUAGE QuasiQuotes #-}

module Web.Hyperbole.Application
  ( waiApp
  , websocketsOr
  , defaultConnectionOptions
  , liveApp
  , socketApp
  , basicDocument
  , routeRequest
  ) where

import Control.Monad (forever)
import Data.Bifunctor (first)
import Data.ByteString.Lazy qualified as BL
import Data.Maybe (fromMaybe)
import Data.String.Conversions (cs)
import Data.String.Interpolate (i)
import Data.Text (Text)
import Data.Text qualified as T
import Effectful
import Effectful.Concurrent.Async
import Effectful.Dispatch.Dynamic
import Effectful.Error.Static
import Effectful.Exception (SomeException, trySync)
import Network.HTTP.Types as HTTP (parseQuery)
import Network.Wai qualified as Wai
import Network.Wai.Handler.WebSockets (websocketsOr)
import Network.WebSockets (Connection, PendingConnection, defaultConnectionOptions)
import Network.WebSockets qualified as WS
import Web.Cookie qualified
import Web.Hyperbole.Data.Cookie qualified as Cookie
import Web.Hyperbole.Effect.Hyperbole
import Web.Hyperbole.Effect.Request (reqPath)
import Web.Hyperbole.Effect.Server (Host (..), InternalServerError (..), Request (..), RequestId (..), Response (..), Server, SocketError (..), runServerSockets, runServerWai, serverError)
import Web.Hyperbole.Effect.Server.Socket qualified as Socket
import Web.Hyperbole.Route
import Web.Hyperbole.View.Embed (cssResetEmbed, scriptEmbed)


{- | Turn one or more 'Page's into a Wai Application. Respond using both HTTP and WebSockets

> #EMBED Example/Docs/BasicPage.hs main
-}
liveApp :: (BL.ByteString -> BL.ByteString) -> Eff '[Hyperbole, Server, Concurrent, IOE] Response -> Wai.Application
liveApp toDoc app req res = do
  websocketsOr
    defaultConnectionOptions
    (runEff . runConcurrent . socketApp app)
    (waiApp toDoc app)
    req
    res


waiApp :: (BL.ByteString -> BL.ByteString) -> Eff '[Hyperbole, Server, Concurrent, IOE] Response -> Wai.Application
waiApp toDoc actions req res = do
  rr <- runEff $ runConcurrent $ runServerWai toDoc req res $ runHyperbole actions
  case rr of
    Nothing -> error "Missing required response in handler"
    Just r -> pure r


socketApp :: (IOE :> es, Concurrent :> es) => Eff (Hyperbole : Server : es) Response -> PendingConnection -> Eff es ()
socketApp actions pend = do
  conn <- liftIO $ WS.acceptRequest pend
  forever $ do
    ereq <- runErrorNoCallStack @SocketError $ receiveRequest conn
    case ereq of
      -- this is a Hyperbole developer error
      Left e -> liftIO $ putStrLn $ "INTERNAL SOCKET ERROR " <> show e
      Right r -> do
        _ <- async (runRequest conn r)
        pure ()
 where
  runRequest conn req = do
    res <- trySync $ runServerSockets conn req $ runHyperbole actions
    case res of
      Left (ex :: SomeException) -> do
        -- It's not safe to send any exception over the wire
        -- log it to the console and send the error to the client
        liftIO $ print ex
        res2 <- trySync $ Socket.sendError req conn (serverError "Internal Server Error")
        case res2 of
          Left e -> liftIO $ putStrLn $ "Socket Error while sending previous error to client: " <> show e
          Right _ -> pure ()
      Right _ -> pure ()

  receiveRequest :: (IOE :> es, Error SocketError :> es) => Connection -> Eff es Request
  receiveRequest conn = do
    t <- receiveText conn
    case parseMessage t of
      Left e -> throwError e
      Right r -> pure r

  receiveText :: (IOE :> es) => Connection -> Eff es Text
  receiveText conn = do
    -- c <- ask @Connection
    liftIO $ WS.receiveData conn

  parseMessage :: Text -> Either SocketError Request
  parseMessage t = do
    case T.splitOn "\n" t of
      [url, host, cook, reqId, body] -> parse url cook host reqId (Just body)
      [url, host, cook, reqId] -> parse url cook host reqId Nothing
      _ -> Left $ InvalidMessage t
   where
    parseUrl :: Text -> Either SocketError (Text, Text)
    parseUrl u =
      case T.splitOn "?" u of
        [url, query] -> pure (url, query)
        _ -> Left $ InvalidMessage u

    parse :: Text -> Text -> Text -> Text -> Maybe Text -> Either SocketError Request
    parse url cook hst reqId mbody = do
      (u, q) <- parseUrl url
      let pth = path u
          query = HTTP.parseQuery (cs q)
          host = Host $ cs $ header hst
          method = "POST"
          body = cs $ fromMaybe "" mbody
          requestId = RequestId $ header reqId

      cookies <- first (InternalSocket . InvalidCookie (cs cook)) <$> Cookie.parse $ Web.Cookie.parseCookies $ cs $ header cook

      pure $ Request{path = pth, host, query, body, method, cookies, requestId}

    -- drop up to the colon, then ': '
    header = T.drop 2 . T.dropWhile (/= ':')


{- | wrap HTML fragments in a simple document with a custom title and include required embeds

@
'liveApp' (basicDocument "App Title") ('routeRequest' router)
@

You may want to specify a custom document function to import custom javascript, css, or add other information to the \<head\>

> import Data.String.Interpolate (i)
> import Web.Hyperbole (scriptEmbed, cssResetEmbed)
>
> #EMBED Example/Docs/App.hs customDocument
-}
basicDocument :: Text -> BL.ByteString -> BL.ByteString
basicDocument title cnt =
  [i|<html>
      <head>
        <title>#{title}</title>
        <script type="text/javascript">#{scriptEmbed}</script>
        <style type="text/css">#{cssResetEmbed}</style>
      </head>
      <body>#{cnt}</body>
  </html>|]


{- | Route URL patterns to different pages


@
#EMBED Example/Docs/App.hs import Example.Docs.Page

#EMBED Example/Docs/App.hs type UserId

#EMBED Example/Docs/App.hs data AppRoute

#EMBED Example/Docs/App.hs instance Route

#EMBED Example/Docs/App.hs router
@
-}
routeRequest :: (Hyperbole :> es, Route route) => (route -> Eff es Response) -> Eff es Response
routeRequest actions = do
  pth <- reqPath
  case findRoute pth.segments of
    Nothing -> send $ RespondNow NotFound
    Just rt -> actions rt
