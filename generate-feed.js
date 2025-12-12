#!/usr/bin/env node
import { writeFileSync } from 'fs'
import { rssForPath } from './rss.js'

const feed = await rssForPath(
  'https://github.com/wordpress/wordpress-playground.git',
  'trunk',
  'packages/docs/site/docs',
  {
    depth: 100,
    skipPatterns: [/changelog\.md$/i]
  }
)

writeFileSync('docs-feed.xml', feed)
console.log('Generated docs-feed.xml')
