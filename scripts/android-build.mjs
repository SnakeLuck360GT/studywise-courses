// Builds the Android app (a debug APK you can install directly) after
// `npm run android:sync`. Finds a JDK Gradle can run on (21–24) and the Android
// SDK, then copies the APK to release/Studywise-android.apk.
//
//   JAVA_HOME=...  use this JDK
//   ANDROID_HOME=... use this SDK (default: the usual Android Studio location)
//   --release      build an unsigned release APK instead

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, platform } from 'node:os'

const root = resolve(import.meta.dirname, '..')
const android = join(root, 'android')
const win = platform() === 'win32'
const release = process.argv.includes('--release')

function javaVersion(home) {
  const bin = join(home, 'bin', win ? 'java.exe' : 'java')
  if (!existsSync(bin)) return null
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8' })
  const m = /version "(\d+)/.exec(r.stderr || r.stdout || '')
  return m ? Number(m[1]) : null
}

function findJdk() {
  const ok = (h) => {
    const v = h && javaVersion(h)
    return v && v >= 21 && v <= 24 ? h : null
  }
  if (ok(process.env.JAVA_HOME)) return process.env.JAVA_HOME
  const dirs = win
    ? ['C:/Program Files/Java', 'C:/Program Files/Eclipse Adoptium', 'C:/Program Files/Microsoft', 'C:/Program Files/Zulu', join(homedir(), '.jdks')]
    : ['/Library/Java/JavaVirtualMachines', '/usr/lib/jvm', join(homedir(), '.jdks')]
  const studio = win ? ['C:/Program Files/Android/Android Studio/jbr'] : ['/Applications/Android Studio.app/Contents/jbr/Contents/Home']
  for (const s of studio) if (ok(s)) return s
  for (const d of dirs) {
    if (!existsSync(d)) continue
    for (const e of readdirSync(d)) {
      for (const h of [join(d, e), join(d, e, 'Contents', 'Home')]) if (ok(h)) return h
    }
  }
  return null
}

function findSdk() {
  for (const p of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, win ? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk') : join(homedir(), 'Library', 'Android', 'sdk'), join(homedir(), 'Android', 'Sdk')])
    if (p && existsSync(join(p, 'platforms'))) return p
  return null
}

const jdk = findJdk()
if (!jdk) {
  console.error('No JDK 21–24 found for Gradle (Capacitor needs 21). Install JDK 21 (e.g. Temurin) and set JAVA_HOME to it.')
  process.exit(1)
}
const sdk = findSdk()
if (!sdk) {
  console.error('No Android SDK found. Install Android Studio (it sets up the SDK) or set ANDROID_HOME.')
  process.exit(1)
}
writeFileSync(join(android, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '/')}\n`)
console.log(`JDK: ${jdk}\nSDK: ${sdk}`)

const task = release ? 'assembleRelease' : 'assembleDebug'
execFileSync(win ? join(android, 'gradlew.bat') : './gradlew', [task, '--console=plain'], { cwd: android, stdio: 'inherit', env: { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk }, shell: win })

const kind = release ? 'release' : 'debug'
const dir = join(android, 'app', 'build', 'outputs', 'apk', kind)
const apk = readdirSync(dir).find((f) => f.endsWith('.apk'))
mkdirSync(join(root, 'release'), { recursive: true })
const out = join(root, 'release', release ? 'Studywise-android-unsigned.apk' : 'Studywise-android.apk')
copyFileSync(join(dir, apk), out)
console.log(`\nAPK: ${out}`)
