import fs from 'fs-extra'
import type { Manifest } from 'webextension-polyfill'
import type PkgType from '../package.json'
import { isDev, isFirefox, port, r } from '../scripts/utils'

export async function getManifest() {
  const pkg = await fs.readJSON(r('package.json')) as typeof PkgType
  const homepage = (pkg as typeof PkgType & { homepage?: string }).homepage

  const manifest: Manifest.WebExtensionManifest = {
    manifest_version: 3,
    name: pkg.displayName || pkg.name,
    short_name: pkg.shortName,
    version: pkg.version,
    description: pkg.description,
    ...(homepage ? { homepage_url: homepage } : {}),
    action: {
      default_icon: {
        16: 'assets/icon-16.png',
        48: 'assets/icon-48.png',
        128: 'assets/icon-128.png',
      },
      default_popup: 'dist/popup/index.html',
    },
    options_ui: {
      page: 'dist/options/index.html',
      open_in_tab: true,
    },
    chrome_url_overrides: {
      newtab: 'dist/newtab/index.html',
    },
    background: isFirefox
      ? {
          scripts: ['dist/background/index.mjs'],
          type: 'module',
        }
      : {
          service_worker: 'dist/background/index.mjs',
        },
    icons: {
      16: 'assets/icon-16.png',
      48: 'assets/icon-48.png',
      128: 'assets/icon-128.png',
    },
    permissions: [
      'tabs',
      'storage',
      'activeTab',
      'sidePanel',
      'favicon',
    ],
    host_permissions: ['*://*/*'],
    content_security_policy: {
      extension_pages: isDev
        ? `script-src \'self\' http://localhost:${port}; object-src \'self\'`
        : 'script-src \'self\'; object-src \'self\'',
    },
  }

  if (isFirefox) {
    manifest.author = pkg.author
    manifest.sidebar_action = {
      default_panel: 'dist/sidepanel/index.html',
    }
  }
  else {
    (manifest as any).side_panel = {
      default_path: 'dist/sidepanel/index.html',
    }
  }

  return manifest
}
