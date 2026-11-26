// The OpenCode 2.x face of a package whose plugins are written for
// OpenCode 1.x (and magpie's plugin host). OpenCode 2.x loads
// exports["."] and wants its default to be {id, setup(ctx)}.
//
// This package is written for magpie's plugin host, which calls the
// plugin function directly; OpenCode itself has no place for a Codex
// relay, so setup only reports that.
export default {
  id: "@magpie-community/opencode-codex-relay-auth",
  async setup() {
    // Nothing to do: the relay reads magpie's own Codex sign-in, which
    // only magpie has.
    return () => {}
  },
}
