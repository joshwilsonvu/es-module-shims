export function analyzeModuleSyntax (_str) {
  str = _str;
  let err = null;
  try {
    baseParse();
  }
  catch (e) {
    err = e;
  }
  return [oImports, oExports, err];
}

// State:
// (for perf, works because this runs sync)
let i, charCode, str;
// lastTokenIndex
let lastTokenIndex;
// lastOpenTokenIndex
let lastOpenTokenIndex;
// lastTokenIndexStack
// linked list of the form { i (item): index, n (next): nextInList }
let lastTokenIndexStack = null;
// braceDepth
let braceDepth = 0;
// templateStack
let templateStack = { i: 0, n: null };
// imports
let oImports;
// exports
let oExports;

function baseParse () {
  lastTokenIndex = lastOpenTokenIndex = -1;
  oImports = [];
  oExports = [];
  i = -1;
  while (charCode = str.charCodeAt(++i)) {
    // reads into the first non-ws / comment token
    commentWhitespace();
    // reads one token at a time
    parseNext();
    // stores the last (non ws/comment) token for division operator backtracking checks
    // (including on lastTokenIndexStack as we nest structures)
    lastTokenIndex = i;
  }
  if (braceDepth > 0 || templateStack.i !== 0 || lastTokenIndexStack)
    syntaxError();
}

function parseNext () {
  switch (charCode) {
    case 123/*{*/:
      braceDepth++;
    // fallthrough
    case 40/*(*/:
      lastTokenIndexStack = { i: lastTokenIndex, n: lastTokenIndexStack };
      return;
    
    case 125/*}*/:
      if (braceDepth-- === templateStack.i) {
        templateStack = templateStack.n;
        templateString();
        return;
      }
      if (braceDepth < templateStack.i)
        syntaxError();
    // fallthrough
    case 41/*)*/:
      if (!lastTokenIndexStack)
        syntaxError();
      lastOpenTokenIndex = lastTokenIndexStack.i;
      lastTokenIndexStack = lastTokenIndexStack.n;
      return;

    case 39/*'*/:
      singleQuoteString();
      return;
    case 34/*"*/:
      doubleQuoteString();
      return;

    case 96/*`*/:
      templateString();
      return;

    case 47/*/*/: {
      /*
       * Division / regex ambiguity handling
       * based on checking backtrack analysis of:
       * - what token came previously (lastTokenIndex)
       * - what token came before the opening paren or brace (lastOpenTokenIndex)
       *
       * Only known unhandled ambiguities are cases of regexes immediately followed
       * by division, another regex or brace:
       * 
       * /regex/ / x
       * 
       * /regex/
       * {}
       * /regex/
       * 
       * And those cases only show errors when containing "'/` in the regex
       * 
       * Could be fixed tracking stack of last regex, but doesn't seem worth it, and bad for perf
       */
      const lastTokenCode = str.charCodeAt(lastTokenIndex);
      if (!lastTokenCode || isExpressionKeyword(lastTokenIndex) ||
          isExpressionPunctuator(lastTokenCode) ||
          lastTokenCode === 41/*)*/ && isParenKeyword(lastOpenTokenIndex) ||
          lastTokenCode === 125/*}*/ && isExpressionTerminator(lastOpenTokenIndex)) {
        regularExpression();
        return;
      }
      else
        return;
    }

    case 105/*i*/: {
      if (readPrecedingKeyword(i + 5) !== 'import' || readToWsOrPunctuator(i + 6) !== '' && str.charCodeAt(i + 6) !== 46/*.*/)
        return;
      
      const start = i;
      charCode = str.charCodeAt(i += 6);
      commentWhitespace();
      const index = i;
      switch (charCode) {
        // dynamic import
        case 40/*(*/:
          // dynamic import indicated by positive d
          lastTokenIndexStack = { i: i + 5, n: lastTokenIndexStack };
          oImports.push({ s: start, e: start + 6, d: index + 1 });
          return;
        // import.meta
        case 46/*.*/:
          commentWhitespace();
          // import.meta indicated by d === -2
          if (readToWsOrPunctuator(i + 1) === 'meta')
            oImports.push({ s: start, e: i + 5, d: -2 });
          return;
      }
      // import statement (only permitted at base-level)
      if (lastTokenIndexStack === null) {
        readSourceString();
        return;
      }
    }
    
    case 101/*e*/: {
      if (lastTokenIndexStack !== null || readPrecedingKeyword(i + 5) !== 'export' || readToWsOrPunctuator(i + 6) !== '')
        return;
      
      let name;
      charCode = str.charCodeAt(i += 6);
      commentWhitespace();
      switch (charCode) {
        // export default ...
        case 100/*d*/:
          oExports.push('default');
          return;

        // export async? function*? name () {
        case 97/*a*/:
          charCode = str.charCodeAt(i += 5);
          commentWhitespace();
        // fallthrough
        case 102/*f*/:
          charCode = str.charCodeAt(i += 8);
          commentWhitespace();
          if (charCode === 42/***/)
            commentWhitespace();
          oExports.push(readToWsOrPunctuator(i));
          return;

        case 99/*c*/:
          if (readToWsOrPunctuator(i) === 'class') {
            charCode = str.charCodeAt(i += 5);
            commentWhitespace();
            oExports.push(readToWsOrPunctuator(i));
            return;
          }
          i += 2;
        // fallthrough

        // export var/let/const name = ...(, name = ...)+
        case 118/*v*/:
        case 108/*l*/:
          /*
           * destructured initializations not currently supported (skipped for { or [)
           * also, lexing names after variable equals is skipped (export var p = function () { ... }, q = 5 skips "q")
           */
          do {
            charCode = str.charCodeAt(i += 3);
            commentWhitespace();
            name = readToWsOrPunctuator(i);
            // stops on [ { destructurings
            if (!name.length)
              return;
            oExports.push(name);
            charCode = str.charCodeAt(i += name.length);
            commentWhitespace();
          } while (charCode === 44/*,*/);
          return;

        // export {...}
        case 123/*{*/:
          charCode = str.charCodeAt(++i);
          commentWhitespace();
          do {
            name = readToWsOrPunctuator(i);
            charCode = str.charCodeAt(i += name.length);
            commentWhitespace();
            // as
            if (charCode === 97/*a*/) {
              charCode = str.charCodeAt(i += 2);
              commentWhitespace();
              name = readToWsOrPunctuator(i);
              charCode = str.charCodeAt(i += name.length);
              commentWhitespace();
            }
            // ,
            if (charCode === 44) {
              charCode = str.charCodeAt(++i);
              commentWhitespace();
            }
            oExports.push(name);
            if (!charCode)
              syntaxError();
          } while (charCode !== 125/*}*/);
        // fallthrough

        // export *
        case 42/***/:
          charCode = str.charCodeAt(++i);
          commentWhitespace();
          if (str.slice(i, i += 4) === 'from')
            readSourceString();
      }
    }
  }
}


/*
 * Helper functions
 */

// seeks through comments and multiline comments
function commentWhitespace () {
  do {
    if (charCode === 47/*/*/) {
      const nextCharCode = str.charCodeAt(i + 1);
      if (nextCharCode === 47/*/*/) {
        charCode = nextCharCode;
        i++;
        lineComment();
      }
      else if (nextCharCode === 42/***/) {
        charCode = nextCharCode;
        i++;
        blockComment();
      }
      else {
        return;
      }
    }
    else if (!isBrOrWs(charCode)) {
      return;
    }
  } while (charCode = str.charCodeAt(++i));
}

function templateString () {
  while (charCode = str.charCodeAt(++i)) {
    if (charCode === 92/*\*/) {
      charCode = str.charCodeAt(++i);
    }
    else if (charCode === 36/*$*/) {
      charCode = str.charCodeAt(++i);
      if (charCode === 123/*{*/) {
        templateStack = { i: ++braceDepth, n: templateStack };
        return;
      }
    }
    else if (charCode === 96/*`*/) {
      return;
    }
  }
  syntaxError();
}

function readSourceString () {
  let start;
  do {
    if (charCode === 39/*'*/) {
      start = i + 1;
      singleQuoteString();
      oImports.push({ s: start, e: i, d: -1 });
      return;
    }
    if (charCode === 34/*"*/) {
      start = i + 1;
      doubleQuoteString();
      oImports.push({ s: start, e: i, d: -1 });
      return;
    }
  } while (charCode = str.charCodeAt(++i))
  syntaxError();
}

export function isWs () {
  // Note there are even more than this - https://en.wikipedia.org/wiki/Whitespace_character#Unicode
  return charCode === 32/* */ || charCode === 9/*\t*/ || charCode === 12/*\f*/ || charCode === 11/*\v*/ || charCode === 160/*\u00A0*/ || charCode === 65279/*\ufeff*/;
}
export function isBr () {
  // (8232 <LS> and 8233 <PS> omitted for now)
  return charCode === 10/*\n*/ || charCode === 13/*\r*/;
}

export function isBrOrWs (charCode) {
  return charCode > 8 && charCode < 14 || charCode === 32 || charCode === 160 || charCode === 65279;
}

export function blockComment () {
  charCode = str.charCodeAt(++i);
  while (charCode) {
    if (charCode === 42/***/) {
      charCode = str.charCodeAt(++i);
      if (charCode === 47/*/*/)
        return;
    }
    charCode = str.charCodeAt(++i);
  }
}

export function lineComment () {
  while (charCode = str.charCodeAt(++i)) {
    if (isBr(charCode))
      return;
  }
}

export function singleQuoteString () {
  while (charCode = str.charCodeAt(++i)) {
    if (charCode === 39/*'*/)
      return;
    if (charCode === 92/*\*/)
      i++;
    else if (isBr(charCode))
      syntaxError();
  }
  syntaxError();
}

export function doubleQuoteString () {
  while (charCode = str.charCodeAt(++i)) {
    if (charCode === 34/*"*/)
      return;
    if (charCode === 92/*\*/)
      i++;
    else if (isBr(charCode))
      syntaxError();
  }
  syntaxError();
}

export function regexCharacterClass () {
  while (charCode = str.charCodeAt(++i)) {
    if (charCode === 93/*]*/)
      return;
    if (charCode === 92/*\*/)
      i++;
    else if (isBr(charCode))
      syntaxError();
  }
  syntaxError();
}

export function regularExpression () {
  while (charCode = str.charCodeAt(++i)) {
    if (charCode === 47/*/*/)
      return;
    if (charCode === 91/*[*/)
      regexCharacterClass();
    else if (charCode === 92/*\*/)
      i++;
    else if (isBr(charCode))
      syntaxError();
  }
  syntaxError();
}

export function readPrecedingKeyword (endIndex) {
  let startIndex = endIndex;
  let nextChar = str.charCodeAt(startIndex);
  while (nextChar && nextChar > 96/*a*/ && nextChar < 123/*z*/)
    nextChar = str.charCodeAt(--startIndex);
  // must be preceded by punctuator or whitespace
  if (nextChar && !isBrOrWs(nextChar) && !isPunctuator(nextChar))
    return '';
  return str.slice(startIndex + 1, endIndex + 1);
}

export function readToWsOrPunctuator (startIndex) {
  let endIndex = startIndex;
  let nextChar = str.charCodeAt(endIndex);
  while (nextChar && !isBrOrWs(nextChar) && !isPunctuator(nextChar))
    nextChar = str.charCodeAt(++endIndex);
  return str.slice(startIndex, endIndex);
}

const expressionKeywords = {
  case: 1,
  debugger: 1,
  delete: 1,
  do: 1,
  else: 1,
  in: 1,
  instanceof: 1,
  new: 1,
  return: 1,
  throw: 1,
  typeof: 1,
  void: 1,
  yield: 1,
  await: 1
};
export function isExpressionKeyword (lastTokenIndex) {
  return expressionKeywords[readPrecedingKeyword(lastTokenIndex)];
}
export function isParenKeyword  (lastTokenIndex) {
  const precedingKeyword = readPrecedingKeyword(lastTokenIndex);
  return precedingKeyword === 'while' || precedingKeyword === 'for' || precedingKeyword === 'if';
}
function isPunctuator (charCode) {
  // 23 possible punctuator endings: !%&()*+,-./:;<=>?[]^{}|~
  return charCode === 33 || charCode === 37 || charCode === 38 ||
    charCode > 39 && charCode < 48 || charCode > 57 && charCode < 64 ||
    charCode === 91 || charCode === 93 || charCode === 94 ||
    charCode > 122 && charCode < 127;
}
export function isExpressionPunctuator (charCode) {
  return isPunctuator(charCode) && charCode !== 93/*]*/ && charCode !== 41/*)*/ && charCode !== 125/*}*/;
}
export function isExpressionTerminator (lastTokenIndex) {
  // detects:
  // ; ) -1 finally while
  // as all of these followed by a { will indicate a statement brace
  // in future we will need: "catch" (optional catch parameters)
  //                         "do" (do expressions)
  switch (str.charCodeAt(lastTokenIndex)) {
    case 59/*;*/:
    case 41/*)*/:
    case NaN:
      return true;
    case 121/*y*/:
      return str.slice(lastTokenIndex - 6, lastTokenIndex) === 'finall';
    case 101/*e*/:
      return str.slice(lastTokenIndex - 4, lastTokenIndex) === 'whil';
  }
  return false;
}

export function syntaxError () {
  // we just need the stack
  // this isn't shown to users, only for diagnostics
  throw new Error();
}