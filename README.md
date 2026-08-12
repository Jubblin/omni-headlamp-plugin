# omni-manager

A [Headlamp](https://github.com/kubernetes-sigs/headlamp) plugin for managing [Sidero Omni](https://www.siderolabs.com/platform/saas-for-kubernetes/) `ConfigPatch` and `MachineClass` resources — viewing, editing, and deleting them from inside Headlamp instead of the `omnictl` CLI.

- View and search `ConfigPatch`/`MachineClass` lists per Omni instance.
- Edit a resource's spec with an inline diff view before applying, including a plain-language summary of what changed.
- Safe by construction: optimistic-concurrency conflict detection (refuses to silently overwrite someone else's concurrent edit) and a type-the-name confirmation step before delete, since delete has no undo.
- Authenticates via an Omni service account key, entered per browser tab and held only in that tab's session storage — never persisted, never sent anywhere except signed requests to your Omni instance.

**Deploying this?** See [DEPLOYMENT.md](./DEPLOYMENT.md) — it needs one setting on the Headlamp server (`-proxy-urls`) in addition to the plugin's own settings panel.

## Developing Headlamp plugins

For more information on developing Headlamp plugins, please refer to:

- [Getting Started](https://headlamp.dev/docs/latest/development/plugins/), How to create a new Headlamp plugin.
- [API Reference](https://headlamp.dev/docs/latest/development/api/), API documentation for what you can do
- [UI Component Storybook](https://headlamp.dev/docs/latest/development/frontend/#storybook), pre-existing components you can use when creating your plugin.
- [Plugin Examples](https://github.com/kubernetes-sigs/headlamp/tree/main/plugins/examples), Example plugins you can look at to see how it's done.
