// Offline contract test for the prebuilt client bundle (lib/client.js).
//
// The browser loads this file as a classic script that calls
// window.__ModuleLoader__.load({ id, factory }). We run exactly that shape in a
// sandbox with a stub require(), then drive the plugin's apply() against a stub
// slots service, so a broken factory, a bad registration or a missing export
// fails here instead of silently in the page.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`ok   ${name}`)
  } else {
    fail += 1
    console.log(`FAIL ${name} ${detail}`)
  }
}

const file = resolve(import.meta.dirname, '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')
const registrations = []
let loadCall = null

const windowStub = {
  __ModuleLoader__: {
    load(options) {
      loadCall = options
    },
  },
}

// Classic-script body; `window` is the only free global it may touch at load.
Function('window', source)(windowStub)
check('bundle calls load once', loadCall !== null)
check('bundle id matches package', loadCall?.id === 'dsh-video-read', String(loadCall?.id))
check('bundle factory is a function', typeof loadCall?.factory === 'function')

const hooks = {
  createElement: () => null,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}
const requireStub = (specifier) => {
  if (specifier === 'react') return hooks
  if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
  if (specifier === '@deepseek-ai/cordis') return {}
  throw new Error(`client bundle requested unexpected module ${specifier}`)
}

let exportsObject = null
try {
  exportsObject = loadCall.factory(requireStub)
} catch (error) {
  check('bundle factory runs', false, String(error?.stack ?? error))
}
check('bundle factory runs', exportsObject !== null)
check('bundle exports name', typeof exportsObject?.name === 'string', String(exportsObject?.name))
check('bundle exports apply', typeof exportsObject?.apply === 'function')
check('bundle injects slots', Array.isArray(exportsObject?.inject) && exportsObject.inject.includes('slots'), JSON.stringify(exportsObject?.inject))

const ctx = {
  slots: {
    inject(slotName, callback) {
      check('applied injects settings.section', slotName === 'settings.section', String(slotName))
      return callback()
    },
    register(registration, component) {
      registrations.push({ registration, component })
      return () => {}
    },
  },
}
try {
  exportsObject.apply(ctx)
} catch (error) {
  check('apply runs against stub context', false, String(error?.stack ?? error))
}
check('apply runs against stub context', registrations.length === 1)
const entry = registrations[0]
check('registration name', entry?.registration?.name === 'settings.section', JSON.stringify(entry?.registration?.name))
check('registration id', entry?.registration?.id === 'dsh-video-read', JSON.stringify(entry?.registration?.id))
check('registration order', entry?.registration?.order === 140, String(entry?.registration?.order))
check('registration label', typeof entry?.registration?.label === 'function' && entry.registration.label() === 'Video Reader')
check('component is a function', typeof entry?.component === 'function')

// A registration rejected by the shell (duplicate id, slot not mounted) must not
// crash the plugin: apply() swallows and keeps the rest of the bundle alive.
const failingCtx = {
  slots: {
    inject(slotName, callback) {
      return callback()
    },
    register() {
      throw new Error('slot unavailable')
    },
  },
}
let survived = true
try {
  exportsObject.apply(failingCtx)
} catch {
  survived = false
}
check('apply survives a rejected registration', survived)

console.log(`
${fail ? 'FAILED' : 'ALL OK'} ${pass}/${pass + fail}`)
if (fail) process.exitCode = 1
