import fs from 'fs'
import LRU from '@alloc/quick-lru'
import { parseCandidateStrings, IO, Parsing } from '@tailwindcss/oxide'
import * as sharedState from './sharedState'
import { generateRules } from './generateRules'
import log from '../util/log'
import cloneNodes from '../util/cloneNodes'
import { defaultExtractor } from './defaultExtractor'
import { flagEnabled } from '../featureFlags'

let env = sharedState.env

const builtInExtractors = {
  DEFAULT: defaultExtractor,
}

const builtInTransformers = {
  DEFAULT: (content) => content,
  svelte: (content) => content.replace(/(?:^|\s)class:/g, ' '),
}

function getExtractor(context, fileExtension) {
  let extractors = context.tailwindConfig.content.extract

  return (
    extractors[fileExtension] ||
    extractors.DEFAULT ||
    builtInExtractors[fileExtension] ||
    // Because we call `DEFAULT(context)`, the returning function is always a new function without a
    // stable identity. Marking it with `DEFAULT_EXTRACTOR` allows us to check if it is the default
    // extractor without relying on the function identity.
    Object.assign(builtInExtractors.DEFAULT(context), { DEFAULT_EXTRACTOR: true })
  )
}

function getTransformer(tailwindConfig, fileExtension) {
  let transformers = tailwindConfig.content.transform

  return (
    transformers[fileExtension] ||
    transformers.DEFAULT ||
    builtInTransformers[fileExtension] ||
    builtInTransformers.DEFAULT
  )
}

let extractorCache = new WeakMap()

// Scans template contents for possible classes. This is a hot path on initial build but
// not too important for subsequent builds. The faster the better though — if we can speed
// up these regexes by 50% that could cut initial build time by like 20%.
function getClassCandidates(content, extractor, candidates, seen) {
  if (!extractorCache.has(extractor)) {
    extractorCache.set(extractor, new LRU({ maxSize: 25000 }))
  }

  for (let line of content.split('\n')) {
    line = line.trim()

    if (seen.has(line)) {
      continue
    }
    seen.add(line)

    if (extractorCache.get(extractor).has(line)) {
      for (let match of extractorCache.get(extractor).get(line)) {
        candidates.add(match)
      }
    } else {
      let extractorMatches = extractor(line).filter((s) => s !== '!*')
      let lineMatchesSet = new Set(extractorMatches)

      for (let match of lineMatchesSet) {
        candidates.add(match)
      }

      extractorCache.get(extractor).set(line, lineMatchesSet)
    }
  }
}

/**
 *
 * @param {[import('./offsets.js').RuleOffset, import('postcss').Node][]} rules
 * @param {*} context
 */
function buildStylesheet(rules, context) {
  let sortedRules = context.offsets.sort(rules)

  let returnValue = {
    base: new Set(),
    defaults: new Set(),
    components: new Set(),
    utilities: new Set(),
    variants: new Set(),
  }

  for (let [sort, rule] of sortedRules) {
    returnValue[sort.layer].add(rule)
  }

  return returnValue
}

export default function expandTailwindAtRules(context) {
  return (root) => {
    let layerNodes = {
      base: null,
      components: null,
      utilities: null,
      variants: null,
    }

    root.walkAtRules((rule) => {
      // Make sure this file contains Tailwind directives. If not, we can save
      // a lot of work and bail early. Also we don't have to register our touch
      // file as a dependency since the output of this CSS does not depend on
      // the source of any templates. Think Vue <style> blocks for example.
      if (rule.name === 'tailwind') {
        if (Object.keys(layerNodes).includes(rule.params)) {
          layerNodes[rule.params] = rule
        }
      }
    })

    if (Object.values(layerNodes).every((n) => n === null)) {
      return root
    }

    // ---

    // Find potential rules in changed files
    let candidates = new Set([...(context.candidates ?? []), sharedState.NOT_ON_DEMAND])
    let seen = new Set()

    env.DEBUG && console.time('Reading changed files')

    if (flagEnabled(context.tailwindConfig, 'oxideParser')) {
      let rustParserContent = []
      let regexParserContent = []

      for (let item of context.changedContent) {
        let transformer = getTransformer(context.tailwindConfig, item.extension)
        let extractor = getExtractor(context, item.extension)

        if (transformer === builtInTransformers.DEFAULT && extractor?.DEFAULT_EXTRACTOR === true) {
          rustParserContent.push(item)
        } else {
          regexParserContent.push([item, { transformer, extractor }])
        }
      }

      if (rustParserContent.length > 0) {
        for (let candidate of parseCandidateStrings(
          rustParserContent,
          IO.Parallel | Parsing.Parallel
        )) {
          candidates.add(candidate)
        }
      }

      if (regexParserContent.length > 0) {
        for (let [{ file, content }, { transformer, extractor }] of regexParserContent) {
          content = file ? fs.readFileSync(file, 'utf8') : content
          getClassCandidates(transformer(content), extractor, candidates, seen)
        }
      }
    } else {
      for (let { file, content, extension } of context.changedContent) {
        let transformer = getTransformer(context.tailwindConfig, extension)
        let extractor = getExtractor(context, extension)
        content = file ? fs.readFileSync(file, 'utf8') : content
        getClassCandidates(transformer(content), extractor, candidates, seen)
      }
    }

    env.DEBUG && console.timeEnd('Reading changed files')

    // ---

    // Generate the actual CSS
    let classCacheCount = context.classCache.size

    env.DEBUG && console.time('Generate rules')
    env.DEBUG && console.time('Sorting candidates')
    // TODO: only sort if we are not using the oxide parser (flagEnabled(context.tailwindConfig,
    // 'oxideParser')) AND if we got all the candidates form the oxideParser alone. This will not
    // be the case currently if you have custom transformers / extractors.
    let sortedCandidates = new Set(
      [...candidates].sort((a, z) => {
        if (a === z) return 0
        if (a < z) return -1
        return 1
      })
    )
    env.DEBUG && console.timeEnd('Sorting candidates')
    generateRules(sortedCandidates, context)
    env.DEBUG && console.timeEnd('Generate rules')

    // We only ever add to the classCache, so if it didn't grow, there is nothing new.
    env.DEBUG && console.time('Build stylesheet')
    if (context.stylesheetCache === null || context.classCache.size !== classCacheCount) {
      context.stylesheetCache = buildStylesheet([...context.ruleCache], context)
    }
    env.DEBUG && console.timeEnd('Build stylesheet')

    let {
      defaults: defaultNodes,
      base: baseNodes,
      components: componentNodes,
      utilities: utilityNodes,
      variants: screenNodes,
    } = context.stylesheetCache

    // ---

    // Replace any Tailwind directives with generated CSS

    if (layerNodes.base) {
      layerNodes.base.before(
        cloneNodes([...baseNodes, ...defaultNodes], layerNodes.base.source, {
          layer: 'base',
        })
      )
      layerNodes.base.remove()
    }

    if (layerNodes.components) {
      layerNodes.components.before(
        cloneNodes([...componentNodes], layerNodes.components.source, {
          layer: 'components',
        })
      )
      layerNodes.components.remove()
    }

    if (layerNodes.utilities) {
      layerNodes.utilities.before(
        cloneNodes([...utilityNodes], layerNodes.utilities.source, {
          layer: 'utilities',
        })
      )
      layerNodes.utilities.remove()
    }

    // We do post-filtering to not alter the emitted order of the variants
    const variantNodes = Array.from(screenNodes).filter((node) => {
      const parentLayer = node.raws.tailwind?.parentLayer

      if (parentLayer === 'components') {
        return layerNodes.components !== null
      }

      if (parentLayer === 'utilities') {
        return layerNodes.utilities !== null
      }

      return true
    })

    if (layerNodes.variants) {
      layerNodes.variants.before(
        cloneNodes(variantNodes, layerNodes.variants.source, {
          layer: 'variants',
        })
      )
      layerNodes.variants.remove()
    } else if (variantNodes.length > 0) {
      let cloned = cloneNodes(variantNodes, undefined, {
        layer: 'variants',
      })

      cloned.forEach((node) => {
        let parentLayer = node.raws.tailwind?.parentLayer ?? null

        node.walk((n) => {
          if (!n.source) {
            n.source = layerNodes[parentLayer].source
          }
        })
      })

      root.append(cloned)
    }

    // If we've got a utility layer and no utilities are generated there's likely something wrong
    const hasUtilityVariants = variantNodes.some(
      (node) => node.raws.tailwind?.parentLayer === 'utilities'
    )

    if (layerNodes.utilities && utilityNodes.size === 0 && !hasUtilityVariants) {
      log.warn('content-problems', [
        'No utility classes were detected in your source files. If this is unexpected, double-check the `content` option in your Tailwind CSS configuration.',
        'https://tailwindcss.com/docs/content-configuration',
      ])
    }

    // ---

    if (env.DEBUG) {
      console.log('Potential classes: ', candidates.size)
      console.log('Active contexts: ', sharedState.contextSourcesMap.size)
    }

    // Clear the cache for the changed files
    context.changedContent = []

    // Cleanup any leftover @layer atrules
    root.walkAtRules('layer', (rule) => {
      if (Object.keys(layerNodes).includes(rule.params)) {
        rule.remove()
      }
    })
  }
}
