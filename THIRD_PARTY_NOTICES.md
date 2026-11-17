# Third party components

The plugin has no third-party JavaScript runtime dependencies. The native sandbox helper is built from the included C# source with the Windows .NET Framework compiler and calls documented Windows APIs; Windows and .NET are not redistributed.

Development dependencies are TypeScript (Apache-2.0), @types/node (MIT), and its undici-types dependency (MIT). Development dependency directories are excluded from the distribution. Keep their own license files when redistributing those packages separately.

The host-provided Node.js runtime is not redistributed by this plugin. The runtime's original license and notices continue to apply.
