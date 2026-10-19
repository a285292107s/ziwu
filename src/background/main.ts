if (import.meta.hot) {
  import('/@vite/client' as string)
}

const USE_SIDE_PANEL = false

interface SidePanelApi {
  setPanelBehavior: (options: { openPanelOnActionClick: boolean }) => Promise<void>
}

const sidePanel = (browser as unknown as { sidePanel?: SidePanelApi }).sidePanel

if (USE_SIDE_PANEL) {
  sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch((error: unknown) => console.error(error))
}

browser.runtime.onInstalled.addListener((): void => {
  console.log('Extension installed')
})
