// The SDK's published declarations reference `ws` without declaring it. The
// SMS adapter uses no websocket surface, but this minimal ambient shape keeps
// the SDK's exported request/response types type-checkable under strict mode.
declare module "ws" {
  class WebSocket {}
  namespace WebSocket {
    interface ClientOptions {
      readonly [option: string]: unknown;
    }
  }
  export default WebSocket;
}
