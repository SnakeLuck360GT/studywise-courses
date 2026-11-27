// The phone has no file system for the desktop code to use: file work runs on the computer.
const no = (name: string) => () => {
  throw new Error(`That needs your computer (${name} isn’t available on the phone).`)
}
export const existsSync = () => false
export const readFileSync = no('readFile')
export const writeFileSync = no('writeFile')
export const appendFileSync = () => {}
export const mkdirSync = () => undefined
export const mkdtempSync = no('mkdtemp')
export const rmSync = () => {}
export const copyFileSync = no('copyFile')
export const renameSync = no('rename')
export const statSync = no('stat')
export const readdirSync = () => []
export const promises = {}
export default { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, renameSync, statSync, readdirSync, promises }
