#!/usr/bin/env node
import { writeFileSync } from 'fs'
import { rssForPath } from './rss.js'

const feed = await rssForPath(
  'https://github.com/wordpress/wordpress-playground.git',
  'trunk',
  'packages/docs/site/docs',
  {
    depth: 100,
    skipPatterns: [/changelog\.md$/i],
    // Disable blob fetching for whitespace checks - the extra fetch request
    // often fails in CI with "other side closed" errors from GitHub
    checkWhitespace: false
  }
)

writeFileSync('docs-feed.xml', feed)
console.log('Generated docs-feed.xml')
