(function () {
  let mode = null

  try {
    mode = window.localStorage.getItem('meridiem-theme-mirror')
  }
  catch (error) {
    void error
  }

  if (mode !== 'dark' && mode !== 'light') {
    mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }

  const root = document.documentElement
  root.classList.toggle('dark', mode === 'dark')
  root.classList.toggle('light', mode === 'light')
  root.style.colorScheme = mode
})()
