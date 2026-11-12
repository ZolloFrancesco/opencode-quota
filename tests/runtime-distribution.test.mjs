import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'))
const sha256 = content => createHash('sha256').update(content).digest('hex')

async function files(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    assert.equal(entry.isSymbolicLink(), false)
    if (entry.isDirectory()) found.push(...await files(path))
    else if (entry.isFile()) found.push(path)
  }
  return found
}

test('il pacchetto installabile non richiede compilazione o dipendenze di sviluppo', async () => {
  const pkg = await json('package.json')
  assert.equal(pkg.version, '6.2.2+local.mistral-vibe')
  for (const key of ['scripts', 'devDependencies', 'packageManager']) {
    assert.equal(Object.hasOwn(pkg, key), false)
  }
  assert.equal(pkg.dependencies['@opentelemetry/api'], '~1.9.1')
  assert.equal(pkg.dependencies['@opentelemetry/sdk-metrics'], undefined)
  const targets = [pkg.main, pkg.types, ...Object.values(pkg.bin)]
  for (const target of Object.values(pkg.exports)) {
    targets.push(...(typeof target === 'string' ? [target] : Object.values(target)))
  }
  targets.push('dist/lib/mistral-vibe-quota.py', 'dist/data/modelsdev-pricing.min.json')
  for (const target of targets) await access(join(root, target))
})

test('tutta la build corrisponde al digest registrato e al lockfile sorgente', async () => {
  const artifact = await json('runtime-artifact.json')
  assert.equal(artifact.sourceCommit, '0d6e5b33510f06242012a73e6869881847672563')
  assert.equal(sha256(await readFile(join(root, 'pnpm-lock.yaml'))), artifact.sourceLockfileSha256)
  const paths = (await files(join(root, 'dist'))).sort()
  const entries = []
  for (const path of paths) {
    entries.push(`${relative(root, path)}\0${sha256(await readFile(path))}\n`)
  }
  assert.equal(paths.length, artifact.distFiles)
  assert.equal(sha256(entries.join('')), artifact.distSha256)
})
