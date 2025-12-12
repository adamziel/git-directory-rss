import { Buffer } from 'buffer'
import { inflateSync } from 'zlib'
import { createHash } from 'crypto'

/**
 * Fetches commit history for a branch, filters commits that changed a path,
 * and emits an Atom feed. Uses blob:none filter for speed - no file content downloaded.
 *
 * @param {string} repoUrl - Git repository URL (e.g., 'https://github.com/owner/repo.git')
 * @param {string} branch - Branch name to monitor
 * @param {string} targetPath - Path within repo to watch for changes
 * @param {Object} options - Configuration options
 * @param {number} options.depth - Number of commits to fetch (default: 50)
 * @param {RegExp[]} options.skipPatterns - Array of regexps to exclude files (default: [/changelog\.md$/i])
 */
async function rssForPath(repoUrl, branch, targetPath, options = {}) {
  const {
    depth = 50,
    skipPatterns = [/changelog\.md$/i]
  } = options

  const shouldSkip = (filePath) => skipPatterns.some(re => re.test(filePath))
  console.time('total')

  // 1. Get the branch ref
  console.time('lsRefs')
  const refs = await lsRefs(repoUrl, `refs/heads/${branch}`)
  const commitHash = refs[`refs/heads/${branch}`]
  if (!commitHash) {
    throw new Error(`Branch ${branch} not found. Available: ${Object.keys(refs).join(', ')}`)
  }
  console.timeEnd('lsRefs')
  console.log(`Found ${branch} at ${commitHash}`)

  // 2. Fetch commits and trees only (no blobs!)
  console.time('fetchWithoutBlobs')
  const objects = await fetchWithoutBlobs(repoUrl, commitHash, depth)
  console.timeEnd('fetchWithoutBlobs')
  console.log(`Fetched ${objects.size} objects`)

  // 3. Walk commit history
  console.time('walkCommits')
  const commits = []
  let currentOid = commitHash
  while (currentOid && commits.length < depth) {
    const obj = objects.get(currentOid)
    if (!obj || obj.type !== 'commit') break
    const commit = parseCommit(obj.data)
    commits.push({ oid: currentOid, commit })
    currentOid = commit.parent?.[0]
  }
  console.timeEnd('walkCommits')
  console.log(`Found ${commits.length} commits`)

  // 4. Filter commits where targetPath changed and collect changed files
  console.time('filterCommits')
  const pathParts = targetPath.split('/').filter(Boolean)
  const changedCommits = []

  for (let i = 0; i < commits.length; i++) {
    const { oid, commit } = commits[i]
    const parentOid = commit.parent?.[0]

    const currentPathOid = getPathOid(objects, commit.tree, pathParts)
    let parentPathOid = null
    let parentCommitObj = null
    if (parentOid) {
      const parentObj = objects.get(parentOid)
      if (parentObj?.type === 'commit') {
        parentCommitObj = parseCommit(parentObj.data)
        parentPathOid = getPathOid(objects, parentCommitObj.tree, pathParts)
      }
    }

    if (currentPathOid !== parentPathOid) {
      // Only diff if we have both trees available - otherwise we can't reliably determine changes
      if (currentPathOid && parentPathOid) {
        const allChangedFiles = getChangedFiles(
          objects,
          currentPathOid,
          parentPathOid,
          targetPath
        ).filter(f => f.path.endsWith('.md') && !shouldSkip(f.path))

        if (allChangedFiles.length > 0) {
          changedCommits.push({ oid, commit, changedFiles: allChangedFiles })
        }
      } else if (currentPathOid && !parentPathOid) {
        // Parent tree not available (outside shallow fetch depth or path was newly added)
        // Mark as changed but don't list individual files since we can't compare
        changedCommits.push({ oid, commit, changedFiles: [], parentUnavailable: true })
      }
      // If currentPathOid is null but parentPathOid exists, path was deleted - skip
    }
  }
  console.timeEnd('filterCommits')

  // Fetch blobs for .md files to check for whitespace-only changes
  // Only need blobs for files that have both current and parent (modifications, not add/delete)
  console.time('fetchBlobs')
  const blobOidsToFetch = new Set()
  for (const { changedFiles } of changedCommits) {
    for (const file of changedFiles) {
      // Only fetch if file was modified (not added/deleted)
      if (file.currentOid && file.parentOid) {
        blobOidsToFetch.add(file.currentOid)
        blobOidsToFetch.add(file.parentOid)
      }
    }
  }
  let blobs = new Map()
  if (blobOidsToFetch.size > 0) {
    blobs = await fetchBlobs(repoUrl, [...blobOidsToFetch])
  }
  console.timeEnd('fetchBlobs')
  console.log(`Fetched ${blobs.size} blobs for whitespace check`)

  // Filter out whitespace-only changes
  for (const commitData of changedCommits) {
    commitData.changedFiles = commitData.changedFiles.filter(file => {
      // New or deleted files are always significant
      if (!file.currentOid || !file.parentOid) return true

      const currentContent = blobs.get(file.currentOid)
      const parentContent = blobs.get(file.parentOid)

      // If we couldn't fetch blobs, assume it's a real change
      if (!currentContent || !parentContent) return true

      // Compare normalized content (ignore whitespace)
      const normalizedCurrent = normalizeWhitespace(currentContent)
      const normalizedParent = normalizeWhitespace(parentContent)

      return normalizedCurrent !== normalizedParent
    })
  }
  
  // Remove commits that now have no changed files (unless parent was unavailable)
  const filteredCommits = changedCommits.filter(c => c.changedFiles.length > 0 && !c.parentUnavailable)
  console.log(`Found ${filteredCommits.length} commits with non-whitespace .md changes`)

  // 5. Generate Atom feed
  // Extract GitHub repo path for commit links (e.g., "wordpress/wordpress-playground")
  const repoPath = repoUrl.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
  const commitUrlBase = `https://github.com/${repoPath}/commit`

  let feed = `<?xml version="1.0" encoding="utf-8" ?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n`
  feed += `<title>Git commits under ${targetPath}</title>\n`
  feed += `<updated>${new Date().toISOString()}</updated>\n`

  for (const { commit, oid, changedFiles, parentUnavailable } of filteredCommits) {
    const date = commit.author.timestamp * 1000
    const title = escapeXml(commit.message.split('\n')[0])
    const commitUrl = `${commitUrlBase}/${oid}`
    // Content: list of changed files first, then PR description
    let filesList = ''
    if (changedFiles.length > 0) {
      filesList = `Changed files:\n${changedFiles.map(f => `- ${f.path}`).join('\n')}\n\n`
    } else if (parentUnavailable) {
      filesList = `(Changed files not available - parent commit outside fetch depth)\n\n`
    }
    const content = escapeXml(filesList + commit.message.trim())
    feed += `<entry>\n`
    feed += `<id>${oid}</id>\n`
    feed += `<link href="${commitUrl}" rel="alternate" type="text/html"/>\n`
    feed += `<updated>${new Date(date).toISOString()}</updated>\n`
    feed += `<title>${title}</title>\n`
    feed += `<content>${content}</content>\n`
    feed += `</entry>\n`
  }

  feed += `</feed>`
  console.timeEnd('total')
  return feed
}

// --- Git Protocol Implementation ---

async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options)
      return response
    } catch (err) {
      if (attempt === maxRetries) throw err
      console.log(`Fetch attempt ${attempt} failed, retrying in ${attempt * 1000}ms...`)
      await new Promise(r => setTimeout(r, attempt * 1000))
    }
  }
}

function pktLine(data) {
  if (data === null) return Buffer.from('0000') // flush
  if (data === 'delim') return Buffer.from('0001')
  const len = (data.length + 4).toString(16).padStart(4, '0')
  return Buffer.from(len + data)
}

async function lsRefs(repoUrl, refPrefix) {
  const body = Buffer.concat([
    pktLine('command=ls-refs\n'),
    pktLine('agent=git/2.37.3\n'),
    pktLine('object-format=sha1\n'),
    pktLine('delim'),
    pktLine('peel\n'),
    pktLine(`ref-prefix ${refPrefix}\n`),
    pktLine(null),
  ])

  const response = await fetchWithRetry(repoUrl + '/git-upload-pack', {
    method: 'POST',
    headers: {
      'Accept': 'application/x-git-upload-pack-advertisement',
      'content-type': 'application/x-git-upload-pack-request',
      'Git-Protocol': 'version=2'
    },
    body,
  })

  const text = await response.text()
  const refs = {}
  let at = 0
  while (at < text.length) {
    const lineLength = parseInt(text.substring(at, at + 4), 16)
    if (lineLength === 0) break
    const line = text.substring(at + 4, at + lineLength)
    const spaceAt = line.indexOf(' ')
    if (spaceAt > 0) {
      const oid = line.slice(0, spaceAt)
      const name = line.slice(spaceAt + 1).trim()
      refs[name] = oid
    }
    at += lineLength
  }
  return refs
}

async function fetchWithoutBlobs(repoUrl, commitHash, depth) {
  const body = Buffer.concat([
    pktLine(`want ${commitHash} ofs-delta side-band-64k agent=git/2.37.3 filter \n`),
    pktLine('filter blob:none\n'),
    pktLine(`deepen ${depth}\n`),
    pktLine(null),
    pktLine('done\n'),
  ])

  const response = await fetchWithRetry(repoUrl + '/git-upload-pack', {
    method: 'POST',
    headers: {
      'Accept': 'application/x-git-upload-pack-advertisement',
      'content-type': 'application/x-git-upload-pack-request',
    },
    body,
  })

  const arrayBuffer = await response.arrayBuffer()
  const data = Buffer.from(arrayBuffer)

  // Extract pack data from side-band-64k framing
  const packData = extractPackFromSideBand(data)
  if (packData.length === 0) {
    console.error('No pack data received. Raw response start:', data.slice(0, 200).toString())
    throw new Error('No pack data received')
  }
  return parsePackfile(packData)
}

async function fetchBlobs(repoUrl, blobOids) {
  if (blobOids.length === 0) return new Map()

  // Use ofs-delta for better compression
  const body = Buffer.concat([
    pktLine(`want ${blobOids[0]} ofs-delta side-band-64k \n`),
    ...blobOids.slice(1).map(oid => pktLine(`want ${oid} \n`)),
    pktLine(null),
    pktLine('done\n'),
  ])

  const response = await fetchWithRetry(repoUrl + '/git-upload-pack', {
    method: 'POST',
    headers: {
      'Accept': 'application/x-git-upload-pack-advertisement',
      'content-type': 'application/x-git-upload-pack-request',
    },
    body,
  })

  const arrayBuffer = await response.arrayBuffer()
  const data = Buffer.from(arrayBuffer)

  const packData = extractPackFromSideBand(data)
  if (packData.length === 0) return new Map()

  const objects = parsePackfile(packData)

  // Extract blob contents
  const blobs = new Map()
  for (const [oid, obj] of objects) {
    if (obj.type === 'blob') {
      blobs.set(oid, obj.data.toString('utf8'))
    }
  }
  return blobs
}

function normalizeWhitespace(str) {
  // Remove all whitespace for comparison
  return str.replace(/\s+/g, '')
}

function extractPackFromSideBand(data) {
  // Side-band-64k wraps data in pkt-line frames with a channel byte
  // Channel 1 = pack data, Channel 2 = progress, Channel 3 = error
  const chunks = []
  let offset = 0

  while (offset < data.length) {
    // Read pkt-line length (4 hex chars)
    const lenHex = data.toString('ascii', offset, offset + 4)
    const len = parseInt(lenHex, 16)

    if (len === 0) {
      offset += 4
      continue // flush packet
    }
    if (len === 1) {
      offset += 4
      continue // delimiter
    }

    const channel = data[offset + 4]
    const payload = data.slice(offset + 5, offset + len)

    if (channel === 1) {
      // Pack data
      chunks.push(payload)
    }
    // Skip channel 2 (progress) and 3 (error)

    offset += len
  }

  return Buffer.concat(chunks)
}

function findPackStart(data) {
  // Look for "PACK" signature, handling side-band framing
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i] === 0x50 && data[i+1] === 0x41 && data[i+2] === 0x43 && data[i+3] === 0x4b) {
      return i
    }
  }
  return -1
}

function parsePackfile(data) {
  const objects = new Map()
  const offsetToOid = new Map() // Track offset -> oid for ofs_delta resolution

  // Verify PACK header
  if (data.toString('utf8', 0, 4) !== 'PACK') {
    throw new Error('Invalid PACK signature')
  }

  const version = data.readUInt32BE(4)
  const numObjects = data.readUInt32BE(8)

  let offset = 12
  const deltas = [] // Store deltas to resolve later

  for (let i = 0; i < numObjects; i++) {
    const result = readPackObject(data, offset, objects)
    offset = result.offset

    if (result.type === 'ofs_delta' || result.type === 'ref_delta') {
      deltas.push(result)
    } else {
      const oid = sha1(result.type, result.data)
      objects.set(oid, { type: result.type, data: result.data })
      offsetToOid.set(result.objectStart, oid)
    }
  }

  // Resolve deltas - may need multiple passes for delta chains
  let resolved = true
  while (resolved && deltas.length > 0) {
    resolved = false
    for (let i = deltas.length - 1; i >= 0; i--) {
      const delta = deltas[i]
      let base = null

      if (delta.type === 'ofs_delta') {
        const baseOffset = delta.objectStart - delta.baseOffset
        const baseOid = offsetToOid.get(baseOffset)
        if (baseOid) base = objects.get(baseOid)
      } else if (delta.type === 'ref_delta') {
        base = objects.get(delta.baseOid)
      }

      if (base) {
        const resolvedData = applyDelta(base.data, delta.data)
        const oid = sha1(base.type, resolvedData)
        objects.set(oid, { type: base.type, data: resolvedData })
        offsetToOid.set(delta.objectStart, oid)
        deltas.splice(i, 1)
        resolved = true
      }
    }
  }

  if (deltas.length > 0) {
    console.warn(`Could not resolve ${deltas.length} deltas`)
  }

  return objects
}

function readPackObject(data, offset, existingObjects) {
  const objectStart = offset
  let byte = data[offset++]
  const type = (byte >> 4) & 0x7
  let size = byte & 0x0f
  let shift = 4

  while (byte & 0x80) {
    byte = data[offset++]
    size |= (byte & 0x7f) << shift
    shift += 7
  }

  const typeNames = ['', 'commit', 'tree', 'blob', 'tag', '', 'ofs_delta', 'ref_delta']
  const typeName = typeNames[type]

  if (typeName === 'ofs_delta') {
    // Read negative offset
    byte = data[offset++]
    let baseOffset = byte & 0x7f
    while (byte & 0x80) {
      byte = data[offset++]
      baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f)
    }
    const { inflated, bytesRead } = inflateObject(data, offset)
    return { type: 'ofs_delta', baseOffset, data: inflated, offset: offset + bytesRead, objectStart }
  }

  if (typeName === 'ref_delta') {
    const baseOid = data.slice(offset, offset + 20).toString('hex')
    offset += 20
    const { inflated, bytesRead } = inflateObject(data, offset)
    return { type: 'ref_delta', baseOid, data: inflated, offset: offset + bytesRead, objectStart }
  }

  const { inflated, bytesRead } = inflateObject(data, offset)
  return { type: typeName, data: inflated, offset: offset + bytesRead, objectStart }
}

function inflateObject(data, offset) {
  // Try different sizes to find valid zlib data
  for (let len = 2; len <= data.length - offset; len++) {
    try {
      const inflated = inflateSync(data.slice(offset, offset + len))
      return { inflated, bytesRead: len }
    } catch (e) {
      if (len === data.length - offset) {
        throw new Error('Failed to inflate object')
      }
    }
  }
  throw new Error('Failed to inflate object')
}

function sha1(type, data) {
  const header = Buffer.from(`${type} ${data.length}\0`)
  return createHash('sha1').update(header).update(data).digest('hex')
}

function applyDelta(base, delta) {
  let srcSize = 0, dstSize = 0, offset = 0

  // Read source size
  let shift = 0
  let byte
  do {
    byte = delta[offset++]
    srcSize |= (byte & 0x7f) << shift
    shift += 7
  } while (byte & 0x80)

  // Read dest size
  shift = 0
  do {
    byte = delta[offset++]
    dstSize |= (byte & 0x7f) << shift
    shift += 7
  } while (byte & 0x80)

  const result = Buffer.alloc(dstSize)
  let resultOffset = 0

  while (offset < delta.length) {
    const cmd = delta[offset++]
    if (cmd & 0x80) {
      // Copy from base
      let copyOffset = 0, copySize = 0
      if (cmd & 0x01) copyOffset = delta[offset++]
      if (cmd & 0x02) copyOffset |= delta[offset++] << 8
      if (cmd & 0x04) copyOffset |= delta[offset++] << 16
      if (cmd & 0x08) copyOffset |= delta[offset++] << 24
      if (cmd & 0x10) copySize = delta[offset++]
      if (cmd & 0x20) copySize |= delta[offset++] << 8
      if (cmd & 0x40) copySize |= delta[offset++] << 16
      if (copySize === 0) copySize = 0x10000
      base.copy(result, resultOffset, copyOffset, copyOffset + copySize)
      resultOffset += copySize
    } else if (cmd) {
      // Insert new data
      delta.copy(result, resultOffset, offset, offset + cmd)
      resultOffset += cmd
      offset += cmd
    }
  }

  return result
}

// --- Git Object Parsing ---

function parseCommit(data) {
  const text = data.toString('utf8')
  const lines = text.split('\n')
  const commit = { parent: [] }

  let i = 0
  while (i < lines.length && lines[i]) {
    const line = lines[i]
    if (line.startsWith('tree ')) {
      commit.tree = line.slice(5)
    } else if (line.startsWith('parent ')) {
      commit.parent.push(line.slice(7))
    } else if (line.startsWith('author ')) {
      const match = line.match(/^author (.+) <(.+)> (\d+) ([+-]\d+)$/)
      if (match) {
        commit.author = { name: match[1], email: match[2], timestamp: parseInt(match[3]) }
      }
    }
    i++
  }

  commit.message = lines.slice(i + 1).join('\n')
  return commit
}

function parseTree(data) {
  const entries = []
  let offset = 0

  while (offset < data.length) {
    // Read mode (space-terminated)
    let modeEnd = offset
    while (data[modeEnd] !== 0x20) modeEnd++
    const mode = data.toString('utf8', offset, modeEnd)
    offset = modeEnd + 1

    // Read name (null-terminated)
    let nameEnd = offset
    while (data[nameEnd] !== 0) nameEnd++
    const path = data.toString('utf8', offset, nameEnd)
    offset = nameEnd + 1

    // Read 20-byte SHA
    const oid = data.slice(offset, offset + 20).toString('hex')
    offset += 20

    entries.push({ mode, path, oid, type: mode === '40000' ? 'tree' : 'blob' })
  }

  return entries
}

function getPathOid(objects, treeOid, pathParts) {
  try {
    let currentOid = treeOid
    for (const part of pathParts) {
      const obj = objects.get(currentOid)
      if (!obj || obj.type !== 'tree') return null
      const entries = parseTree(obj.data)
      const entry = entries.find(e => e.path === part)
      if (!entry) return null
      currentOid = entry.oid
    }
    return currentOid
  } catch {
    return null
  }
}

/**
 * Get list of changed files between two tree OIDs (recursively).
 * Returns array of {path, currentOid, parentOid} objects.
 */
function getChangedFiles(objects, currentTreeOid, parentTreeOid, basePath) {
  const changedFiles = []

  function diffTrees(currentOid, parentOid, prefix) {
    const currentEntries = currentOid ? getTreeEntries(objects, currentOid) : []
    const parentEntries = parentOid ? getTreeEntries(objects, parentOid) : []

    // Build maps for quick lookup
    const currentMap = new Map(currentEntries.map(e => [e.path, e]))
    const parentMap = new Map(parentEntries.map(e => [e.path, e]))

    // Check for added/modified entries
    for (const [name, entry] of currentMap) {
      const parentEntry = parentMap.get(name)
      const fullPath = prefix ? `${prefix}/${name}` : name

      if (!parentEntry) {
        // Added
        if (entry.type === 'tree') {
          collectAllFilesWithOids(objects, entry.oid, null, fullPath, changedFiles)
        } else {
          changedFiles.push({ path: fullPath, currentOid: entry.oid, parentOid: null })
        }
      } else if (entry.oid !== parentEntry.oid) {
        // Modified
        if (entry.type === 'tree' && parentEntry.type === 'tree') {
          diffTrees(entry.oid, parentEntry.oid, fullPath)
        } else {
          changedFiles.push({ path: fullPath, currentOid: entry.oid, parentOid: parentEntry.oid })
        }
      }
    }

    // Check for deleted entries
    for (const [name, entry] of parentMap) {
      if (!currentMap.has(name)) {
        const fullPath = prefix ? `${prefix}/${name}` : name
        if (entry.type === 'tree') {
          collectAllFilesWithOids(objects, null, entry.oid, fullPath, changedFiles)
        } else {
          changedFiles.push({ path: fullPath, currentOid: null, parentOid: entry.oid })
        }
      }
    }
  }

  diffTrees(currentTreeOid, parentTreeOid, '')
  return changedFiles
}

function getTreeEntries(objects, treeOid) {
  const obj = objects.get(treeOid)
  if (!obj || obj.type !== 'tree') return []
  return parseTree(obj.data)
}

function collectAllFilesWithOids(objects, currentTreeOid, parentTreeOid, prefix, result) {
  const entries = getTreeEntries(objects, currentTreeOid || parentTreeOid)
  for (const entry of entries) {
    const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path
    if (entry.type === 'tree') {
      collectAllFilesWithOids(objects, currentTreeOid ? entry.oid : null, parentTreeOid ? entry.oid : null, fullPath, result)
    } else {
      result.push({
        path: fullPath,
        currentOid: currentTreeOid ? entry.oid : null,
        parentOid: parentTreeOid ? entry.oid : null
      })
    }
  }
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Export for use as module
export { rssForPath }

// Run if called directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  rssForPath(
    'https://github.com/wordpress/wordpress-playground.git',
    'trunk',
    'packages/docs/site/docs',
    {
      depth: 50,
      skipPatterns: [/changelog\.md$/i]
    }
  )
    .then(xml => console.log(xml))
    .catch(err => console.error(err))
}
