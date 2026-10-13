import type { App } from 'vue'

export type AppContext = 'popup' | 'options' | 'sidepanel' | 'newtab' | 'content-script'

export function setupApp(app: App, context: AppContext) {
  // Inject a globally available `$app` object in template
  app.config.globalProperties.$app = {
    context,
  }

  // Provide access to `app` in script setup with `const app = inject('app')`
  app.provide('app', app.config.globalProperties.$app)

  // Here you can install additional plugins for all contexts: popup, options page and content-script.
  // example: app.use(i18n)
  // example excluding content-script context: if (context !== 'content-script') app.use(i18n)
}
