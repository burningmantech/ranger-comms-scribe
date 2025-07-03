// Test script for incremental changes feature
// Example: original="foo bar baz", latest="food boo bop", next="food baz a bop"
// Expected incremental change: "z a"

function calculateIncrementalChange(previousVersion, currentVersion) {
  // Split into words for better diff calculation
  const previousWords = previousVersion.split(/\s+/);
  const currentWords = currentVersion.split(/\s+/);
  
  // Find the longest common prefix
  let prefixLength = 0;
  while (prefixLength < previousWords.length && 
         prefixLength < currentWords.length && 
         previousWords[prefixLength] === currentWords[prefixLength]) {
    prefixLength++;
  }
  
  // Find the longest common suffix
  let suffixLength = 0;
  while (suffixLength < previousWords.length - prefixLength && 
         suffixLength < currentWords.length - prefixLength && 
         previousWords[previousWords.length - 1 - suffixLength] === currentWords[currentWords.length - 1 - suffixLength]) {
    suffixLength++;
  }
  
  // Extract the changed portions
  const oldWords = previousWords.slice(prefixLength, previousWords.length - suffixLength);
  const newWords = currentWords.slice(prefixLength, currentWords.length - suffixLength);
  
  const oldValue = oldWords.join(' ');
  const newValue = newWords.join(' ');
  
  return { oldValue, newValue };
}

// Test the example
const original = "foo bar baz";
const latest = "food boo bop";
const next = "food baz a bop";

console.log("Original:", original);
console.log("Latest proposed:", latest);
console.log("Next proposed:", next);

const incrementalChange = calculateIncrementalChange(latest, next);
console.log("Incremental change:", incrementalChange);

// Test with the user's example
console.log("\n--- User's Example ---");
console.log("Original: 'foo bar baz'");
console.log("Latest proposed: 'food boo bop'");
console.log("Next proposed: 'food baz a bop'");

const change1 = calculateIncrementalChange("food boo bop", "food baz a bop");
console.log("Incremental change should be: 'boo bop' -> 'baz a bop'");
console.log("Actual result:", change1);

// Test with more examples
console.log("\n--- More Examples ---");

// Example 1: Simple word replacement
const ex1 = calculateIncrementalChange("hello world", "hello there");
console.log("'hello world' -> 'hello there':", ex1);

// Example 2: Multiple word changes
const ex2 = calculateIncrementalChange("the quick brown fox", "the fast red fox");
console.log("'the quick brown fox' -> 'the fast red fox':", ex2);

// Example 3: Adding words
const ex3 = calculateIncrementalChange("hello world", "hello beautiful world");
console.log("'hello world' -> 'hello beautiful world':", ex3); 