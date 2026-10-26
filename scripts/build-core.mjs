import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import AdmZip from 'adm-zip'

const ROOT = path.resolve(import.meta.dirname, '..')
const CONFIG = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src-tauri/core-release.json'), 'utf8'),
)
const PATCH_DIR = path.join(ROOT, 'src-tauri/core-patches')
const SOURCE_DIR = path.join(ROOT, 'node_modules/.verge/mihomo-src')
const SIDECAR_DIR = path.join(ROOT, 'src-tauri/sidecar')
const OUTPUT_DIR = path.join(ROOT, 'dist/core')

const TARGETS = {
  'aarch64-apple-darwin': {
    os: 'darwin',
    arch: 'arm64',
    asset: 'mihomo-darwin-arm64-go122',
  },
  'x86_64-apple-darwin': {
    os: 'darwin',
    arch: 'amd64',
    asset: 'mihomo-darwin-amd64-v2-go122',
  },
  'x86_64-unknown-linux-gnu': {
    os: 'linux',
    arch: 'amd64',
    asset: 'mihomo-linux-amd64-v2',
  },
  'aarch64-unknown-linux-gnu': {
    os: 'linux',
    arch: 'arm64',
    asset: 'mihomo-linux-arm64',
  },
  'x86_64-pc-windows-msvc': {
    os: 'windows',
    arch: 'amd64',
    asset: 'mihomo-windows-amd64-v2',
    ext: '.exe',
  },
  'aarch64-pc-windows-msvc': {
    os: 'windows',
    arch: 'arm64',
    asset: 'mihomo-windows-arm64',
    ext: '.exe',
  },
}

const HOST = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
}[`${process.platform}-${process.arch}`]

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const targetTriple = option('--target') || HOST
const target = TARGETS[targetTriple]
if (!target) {
  console.error(
    `Unsupported target ${targetTriple ?? `${process.platform}-${process.arch}`}. ` +
      `Use --target with one of: ${Object.keys(TARGETS).join(', ')}`,
  )
  process.exit(1)
}
const packageMode = process.argv.includes('--package')
const version = CONFIG.buildVersion
const sourceRepo = CONFIG.buildRepo || 'MetaCubeX/mihomo'

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options })
}

function prepareSource() {
  if (!fs.existsSync(path.join(SOURCE_DIR, '.git'))) {
    fs.rmSync(SOURCE_DIR, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(SOURCE_DIR), { recursive: true })
    console.log(`cloning ${sourceRepo} at ${version}`)
    run('git', [
      'clone',
      '--depth',
      '1',
      '--branch',
      version,
      `https://github.com/${sourceRepo}.git`,
      SOURCE_DIR,
    ])
    return
  }

  let checkedOut = ''
  try {
    checkedOut = execFileSync(
      'git',
      ['-C', SOURCE_DIR, 'describe', '--tags', '--exact-match', 'HEAD'],
      { encoding: 'utf8' },
    ).trim()
  } catch {
    // Not on a tag; refetch below.
  }
  if (checkedOut !== version) {
    console.log(`switching ${SOURCE_DIR} to ${version}`)
    run('git', [
      '-C',
      SOURCE_DIR,
      'fetch',
      '--depth',
      '1',
      'origin',
      'tag',
      version,
    ])
    run('git', ['-C', SOURCE_DIR, 'checkout', '--force', version])
  }

  // Always start from the tag: a changed patch set must not stack on an old worktree.
  run('git', ['-C', SOURCE_DIR, 'reset', '--hard', version])
  run('git', ['-C', SOURCE_DIR, 'clean', '-fdx'])
}

function applyPatches() {
  for (const patch of CONFIG.patches ?? []) {
    const file = path.join(PATCH_DIR, patch)
    if (!fs.existsSync(file)) throw new Error(`missing core patch: ${file}`)
    try {
      execFileSync(
        'git',
        ['-C', SOURCE_DIR, 'apply', '--reverse', '--check', file],
        {
          stdio: 'ignore',
        },
      )
      console.log(`patch already applied: ${patch}`)
    } catch {
      run('git', ['-C', SOURCE_DIR, 'apply', '--check', file])
      run('git', ['-C', SOURCE_DIR, 'apply', file])
      console.log(`applied patch: ${patch}`)
    }
  }
}

function build(binary) {
  const buildTime = new Date().toISOString()
  const ldflags =
    `-X github.com/metacubex/mihomo/constant.Version=${version} ` +
    `-X github.com/metacubex/mihomo/constant.BuildTime=${buildTime} ` +
    '-w -s -buildid='
  console.log(`building ${targetTriple}`)
  run(
    'go',
    [
      'build',
      '-tags',
      'with_gvisor',
      '-trimpath',
      '-ldflags',
      ldflags,
      '-o',
      binary,
      '.',
    ],
    {
      cwd: SOURCE_DIR,
      env: {
        ...process.env,
        CGO_ENABLED: '0',
        GOOS: target.os,
        GOARCH: target.arch,
      },
    },
  )
}

function packageBinary(binary) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const base = path.join(OUTPUT_DIR, `${target.asset}-${version}`)
  if (target.ext === '.exe') {
    const zip = new AdmZip()
    zip.addLocalFile(binary)
    zip.writeZip(`${base}.zip`)
    console.log(`packaged ${base}.zip`)
  } else {
    fs.writeFileSync(`${base}.gz`, zlib.gzipSync(fs.readFileSync(binary)))
    console.log(`packaged ${base}.gz`)
  }
  fs.writeFileSync(path.join(OUTPUT_DIR, 'version.txt'), `${version}\n`)
  console.log(`wrote ${path.join(OUTPUT_DIR, 'version.txt')}`)
}

prepareSource()
applyPatches()

const workBinary = path.join(
  SOURCE_DIR,
  `mihomo-${targetTriple}${target.ext ?? ''}`,
)
build(workBinary)

if (packageMode) {
  packageBinary(workBinary)
  fs.rmSync(workBinary, { force: true })
} else {
  fs.mkdirSync(SIDECAR_DIR, { recursive: true })
  const sidecar = path.join(
    SIDECAR_DIR,
    `verge-mihomo-${targetTriple}${target.ext ?? ''}`,
  )
  fs.copyFileSync(workBinary, sidecar)
  fs.chmodSync(sidecar, 0o755)
  fs.rmSync(workBinary, { force: true })
  console.log(`installed ${sidecar}`)
}
