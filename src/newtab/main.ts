import { createApp } from 'vue'
import App from './NewTab.vue'
import { setupApp } from '~/logic/common-setup'
import '../styles'

const app = createApp(App)
setupApp(app, 'newtab')
app.mount('#app')
