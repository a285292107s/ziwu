import type { App } from 'vue'

export type AppContext = 'popup' | 'options' | 'sidepanel' | 'newtab'

export function setupApp(app: App, context: AppContext) {
  // Inject a globally available `$app` object in template
  app.config.globalProperties.$app = {
    context,
  }

  // Provide access to `app` in script setup with `const app = inject('app')`
  app.provide('app', app.config.globalProperties.$app)

  // Here you can install additional plugins for all contexts: popup, options page, sidepanel and newtab.
  // example: app.use(i18n)
}
