import _ from 'lodash'
import * as mathjs from 'mathjs'
import { isEmptyObj } from '../../../../libs/common/src/utils/object.utils'

/**
 * parse references to other outputs (i.e. {{id.key}})
 */
export function parseStepInputs(
  inputs: Record<string, unknown>,
  outputs: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const parsedInputs: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(inputs)) {
    parsedInputs[key] = parseInput(value, outputs)
  }
  return parsedInputs
}

export function parseInput(input: unknown, outputs: Record<string, Record<string, unknown>>): unknown {
  const variableRegex = /{{\s*([^}]+)\s*}}/

  if (!input) {
    return input
  }
  if (typeof input === 'string') {
    const variables = [...input.matchAll(new RegExp(variableRegex, 'g'))]

    // if the entire input is just one variable, then just return its value
    if (variables.length === 1 && input.trim() === variables[0][0]) {
      return calculateExpression(variables[0][1].trim(), outputs)
    }

    // replace all variables by its value
    return variables.reduce((prev, variableMatch) => {
      return prev.replace(variableMatch[0], stringifyInput(calculateExpression(variableMatch[1].trim(), outputs)))
    }, input)
  }
  if (Array.isArray(input)) {
    return input.map((x) => parseInput(x, outputs))
  }
  if (input && typeof input === 'object') {
    // Don't send empty objects, external integrations might fail validation because of them
    if (isEmptyObj(input)) {
      return
    }
    return Object.entries(input).reduce((prev: Record<string, unknown>, [key, value]) => {
      prev[key] = parseInput(value, outputs)
      return prev
    }, {})
  }
  return input
}

/**
 * Replace references with their values and calculate expression
 * Example:
 *   input: "foo.bar - foo.baz"
 *   references: { foo: { bar: 5, baz: 3 } }
 *   returns: 2
 */
export function calculateExpression(input: string, references: Record<string, Record<string, unknown>>): unknown {
  // each "[\w[\]]" group matches the allowed characters for variables, including array access (e.g. a.b[0].c)
  const operatorsRegex = /[\w[\]]+\.[\w[\]]+(\.[\w[\]]+)*/g

  const operators = [...input.matchAll(operatorsRegex)]

  if (operators.length === 1 && operators[0][0] === input.trim()) {
    return _.get(references, input)
  }

  const expression = operators.reduce((prev, operatorMatch) => {
    // don't replace matches between quotes
    const quoteMatch = input.substring(0, operatorMatch.index).match(/['"]/g)
    const isBetweenQuotes = quoteMatch && quoteMatch.length % 2 === 1
    if (isBetweenQuotes) {
      return prev
    }

    let value = _.get(references, operatorMatch[0]) as unknown
    if (typeof value === 'string' || typeof value === 'object') {
      value = `"${stringifyInput(value)}"`
    }
    return prev.replace(operatorMatch[0], value as string)
  }, input)

  const parser = mathjs.parser()
  parser.set('substring', (str: string, start: number, end: number) => {
    if (!str) {
      return str
    }
    return ('' + str).substring(start, end)
  })
  parser.set('lowercase', (str: string) => (str ? ('' + str).toLowerCase() : str))
  parser.set('uppercase', (str: string) => (str ? ('' + str).toUpperCase() : str))
  parser.set('extract', (str: string, template: string, replace: string) => {
    const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = escaped.replace(/\\\*\\\*\\\*+/g, '(.+)')
    if (str.match(regex)) {
      return str.replace(new RegExp(regex), replace)
    }
    return ''
  })
  return parser.evaluate(expression)
}

function stringifyInput(input: unknown): string {
  if (_.isPlainObject(input)) {
    return JSON.stringify(input)
  } else if (_.isDate(input)) {
    return input.toISOString()
  }
  return (input as string) ?? ''
}
