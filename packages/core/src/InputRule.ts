import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import { Fragment } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import type { TextSelection } from '@tiptap/pm/state'
import { EditorState, Plugin } from '@tiptap/pm/state'

import { CommandManager } from './CommandManager.js'
import type { Editor } from './Editor.js'
import { createChainableState } from './helpers/createChainableState.js'
import { getHTMLFromFragment } from './helpers/getHTMLFromFragment.js'
import { getTextContentFromNodes } from './helpers/getTextContentFromNodes.js'
import type {
  CanCommands,
  ChainedCommands,
  ExtendedRegExpMatchArray,
  Range,
  SingleCommands,
} from './types.js'
import { isRegExp } from './utilities/isRegExp.js'

export type InputRuleMatch = {
  index: number
  text: string
  replaceWith?: string
  match?: RegExpMatchArray
  data?: Record<string, any>
}

export type InputRuleFinder = RegExp | ((text: string) => InputRuleMatch | null)

export class InputRule {
  find: InputRuleFinder

  handler: (props: {
    state: EditorState
    range: Range
    match: ExtendedRegExpMatchArray
    commands: SingleCommands
    chain: () => ChainedCommands
    can: () => CanCommands
  }) => void | null

  undoable: boolean

  constructor(config: {
    find: InputRuleFinder
    handler: (props: {
      state: EditorState
      range: Range
      match: ExtendedRegExpMatchArray
      commands: SingleCommands
      chain: () => ChainedCommands
      can: () => CanCommands
    }) => void | null
    undoable?: boolean
  }) {
    this.find = config.find
    this.handler = config.handler
    this.undoable = config.undoable ?? true
  }
}

const inputRuleMatcherHandler = (
  text: string,
  find: InputRuleFinder,
): ExtendedRegExpMatchArray | null => {
  if (isRegExp(find)) {
    return find.exec(text)
  }

  const inputRuleMatch = find(text)

  if (!inputRuleMatch) {
    return null
  }

  const result: ExtendedRegExpMatchArray = [inputRuleMatch.text]

  result.index = inputRuleMatch.index
  result.input = text
  result.data = inputRuleMatch.data

  if (inputRuleMatch.replaceWith) {
    if (!inputRuleMatch.text.includes(inputRuleMatch.replaceWith)) {
      console.warn(
        '[tiptap warn]: "inputRuleMatch.replaceWith" must be part of "inputRuleMatch.text".',
      )
    }

    result.push(inputRuleMatch.replaceWith)
  }

  return result
}

/**
 * Prepares the typed text so the rule handler can inspect the resulting document.
 */
function createRuleTransaction(config: {
  editor: Editor
  from: number
  to: number
  text: string
  insertText?: boolean
}) {
  const { editor, from, to, text, insertText } = config

  if (!insertText) {
    return { inputTransaction: null, tr: editor.view.state.tr }
  }

  const inputTransaction = editor.view.state.tr.insertText(text, from, to)
  const inputState = EditorState.create({
    doc: inputTransaction.doc,
    selection: inputTransaction.selection,
    storedMarks: inputTransaction.storedMarks,
  })

  return { inputTransaction, tr: inputState.tr }
}

/**
 * Runs a matching rule and dispatches the typed text before its conversion.
 */
function applyRule(config: {
  editor: Editor
  from: number
  to: number
  text: string
  rule: InputRule
  match: ExtendedRegExpMatchArray
  plugin: Plugin
  insertText?: boolean
}): boolean {
  const { editor, from, to, text, rule, match, plugin, insertText } = config
  const { view } = editor
  const { inputTransaction, tr } = createRuleTransaction({ editor, from, to, text, insertText })
  const inputEnd = inputTransaction ? from + text.length : to
  const state = createChainableState({
    state: view.state,
    transaction: tr,
  })
  const range = {
    from: from - (match[0].length - text.length),
    to: inputEnd,
  }

  const { commands, chain, can } = new CommandManager({
    editor,
    state,
  })

  const handler = rule.handler({
    state,
    range,
    match,
    commands,
    chain,
    can,
  })

  if (handler === null || !tr.steps.length) {
    return false
  }

  if (inputTransaction) {
    view.dispatch(inputTransaction)

    // When another plugin's appendTransaction rewrites the document after the
    // typed text is inserted, the pre-built rule transaction is based on a
    // stale plugin-free doc and must not be applied as-is (#8709 / #8708).
    // Rebuild the rule steps against the live editor state instead of bailing
    // and leaving the input-rule marker text in the document.
    if (!view.state.doc.eq(inputTransaction.doc)) {
      const liveTr = view.state.tr
      const liveState = createChainableState({
        state: view.state,
        transaction: liveTr,
      })
      // After typing, the selection head is at the end of the inserted text
      // (possibly remapped by appendTransaction). Derive the match range from
      // that head so the handler sees the same matched span.
      const liveTo = view.state.selection.from
      const liveFrom = liveTo - match[0].length
      const $parentStart = view.state.doc.resolve(liveTo).start()

      if (liveFrom < $parentStart) {
        return true
      }

      const liveRange = { from: liveFrom, to: liveTo }
      const liveCommands = new CommandManager({
        editor,
        state: liveState,
      })

      const liveHandler = rule.handler({
        state: liveState,
        range: liveRange,
        match,
        commands: liveCommands.commands,
        chain: liveCommands.chain,
        can: liveCommands.can,
      })

      if (liveHandler === null || !liveTr.steps.length) {
        return true
      }

      closeHistory(liveTr)
      liveTr.setMeta('inputRule', true)

      if (rule.undoable) {
        liveTr.setMeta(plugin, {
          transform: liveTr,
          from: liveFrom,
          to: liveTo,
          // Typed text is already in the live doc; undo only inverts the rule.
          text: '',
        })
      }

      view.dispatch(liveTr)
      return true
    }
  }

  closeHistory(tr)
  tr.setMeta('inputRule', true)

  if (rule.undoable) {
    tr.setMeta(plugin, {
      transform: tr,
      from,
      to: inputEnd,
      text,
    })
  }

  view.dispatch(tr)
  return true
}

/**
 * Checks that the part of a match already in the document has matching positions.
 */
function matchesDocument($from: ResolvedPos, match: ExtendedRegExpMatchArray, text: string) {
  // Leaf nodes can have different text and document lengths.
  const matchedDocLength = match[0].length - text.length

  if (matchedDocLength <= 0) {
    return true
  }

  const matchStartOffset = $from.parentOffset - matchedDocLength

  return (
    matchStartOffset >= 0 &&
    $from.parent.textBetween(matchStartOffset, $from.parentOffset) ===
      match[0].slice(0, matchedDocLength)
  )
}

function run(config: {
  editor: Editor
  from: number
  to: number
  text: string
  rules: InputRule[]
  plugin: Plugin
  insertText?: boolean
}): boolean {
  const { editor, from, to, text, rules, plugin, insertText } = config
  const { view } = editor

  if (view.composing) {
    return false
  }

  const $from = view.state.doc.resolve(from)

  if (
    // check for code node
    $from.parent.type.spec.code ||
    // check for code mark
    !!($from.nodeBefore || $from.nodeAfter)?.marks.find(mark => mark.type.spec.code)
  ) {
    return false
  }

  const textBefore = getTextContentFromNodes($from) + text

  for (const rule of rules) {
    const match = inputRuleMatcherHandler(textBefore, rule.find)

    if (!match || !matchesDocument($from, match, text)) {
      continue
    }

    if (applyRule({ editor, from, to, text, rule, match, plugin, insertText })) {
      return true
    }
  }

  return false
}

/**
 * Create an input rules plugin. When enabled, it will cause text
 * input that matches any of the given rules to trigger the rule’s
 * action.
 */
export function inputRulesPlugin(props: { editor: Editor; rules: InputRule[] }): Plugin {
  const { editor, rules } = props
  const plugin = new Plugin({
    state: {
      init() {
        return null
      },
      apply(tr, prev, state) {
        const stored = tr.getMeta(plugin)

        if (stored) {
          return stored
        }

        // if InputRule is triggered by insertContent()
        const simulatedInputMeta = tr.getMeta('applyInputRules') as
          | undefined
          | {
              from: number
              text: string | PMNode | Fragment
            }
        const isSimulatedInput = !!simulatedInputMeta

        if (isSimulatedInput) {
          setTimeout(() => {
            let { text } = simulatedInputMeta

            if (typeof text === 'string') {
              text = text as string
            } else {
              text = getHTMLFromFragment(Fragment.from(text), state.schema)
            }

            const { from } = simulatedInputMeta
            const to = from + text.length

            run({
              editor,
              from,
              to,
              text,
              rules,
              plugin,
            })
          })
        }

        return tr.selectionSet || tr.docChanged ? null : prev
      },
    },

    props: {
      handleTextInput(view, from, to, text) {
        return run({
          editor,
          from,
          to,
          text,
          rules,
          plugin,
          insertText: true,
        })
      },

      handleDOMEvents: {
        compositionend: view => {
          setTimeout(() => {
            const { $cursor } = view.state.selection as TextSelection

            if ($cursor) {
              run({
                editor,
                from: $cursor.pos,
                to: $cursor.pos,
                text: '',
                rules,
                plugin,
              })
            }
          })

          return false
        },
      },

      // add support for input rules to trigger on enter
      // this is useful for example for code blocks
      handleKeyDown(view, event) {
        if (event.key !== 'Enter') {
          return false
        }

        const { $cursor } = view.state.selection as TextSelection

        if ($cursor) {
          return run({
            editor,
            from: $cursor.pos,
            to: $cursor.pos,
            text: '\n',
            rules,
            plugin,
          })
        }

        return false
      },
    },

    // @ts-ignore
    isInputRules: true,
  }) as Plugin

  return plugin
}
