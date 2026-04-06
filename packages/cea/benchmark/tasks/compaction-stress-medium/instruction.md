You are working in a tight 6000 token context window. Complete ALL steps:

STEP 1: Create a simple Node.js calculator module at /agent/work/calc.js:
```
function add(a, b) { return a + b; }
function subtract(a, b) { return a - b; }
function multiply(a, b) { return a * b; }
module.exports = { add, subtract, multiply };
```

STEP 2: Create /agent/work/calc.test.js:
```
const calc = require('./calc');
console.assert(calc.add(2, 3) === 5, 'add failed');
console.assert(calc.subtract(10, 4) === 6, 'subtract failed');
console.assert(calc.multiply(3, 4) === 12, 'multiply failed');
console.log('ALL TESTS PASSED');
```

STEP 3: Run the test: use shell_execute to run `node /agent/work/calc.test.js`

STEP 4: Create /agent/work/index.js:
```
const calc = require('./calc');
const result = calc.add(100, 200);
console.log('Result:', result);
```

STEP 5: Run /agent/work/index.js with shell_execute: `node /agent/work/index.js`

STEP 6: Create /agent/work/summary.txt with EXACTLY this content (recall from memory what you built):
Line 1: the function name that adds two numbers (exact name from calc.js)
Line 2: what calc.add(100, 200) returns (just the number)
Line 3: the output message format from index.js (e.g., "Result: 300")
