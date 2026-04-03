You are working in a tight 4000 token context window. Complete ALL steps:

STEP 1: Create /work/data/numbers.txt with 10 lines, one number per line: 42, 17, 99, 5, 73, 28, 61, 14, 88, 33

STEP 2: Create /work/scripts/sum.py:
```python
with open('/work/data/numbers.txt') as f:
    nums = [int(x.strip()) for x in f if x.strip()]
total = sum(nums)
print(f'Sum: {total}')
```

STEP 3: Run: shell_execute `python3 /work/scripts/sum.py`

STEP 4: Create /work/data/words.txt with content:
```
apple
banana
cherry
date
elderberry
```

STEP 5: Create /work/scripts/count.py:
```python
with open('/work/data/words.txt') as f:
    words = [w.strip() for w in f if w.strip()]
print(f'Count: {len(words)}')
print(f'First: {words[0]}')
print(f'Last: {words[-1]}')
```

STEP 6: Run: shell_execute `python3 /work/scripts/count.py`

STEP 7: Create /work/scripts/combine.py:
```python
with open('/work/data/numbers.txt') as f:
    nums = [int(x.strip()) for x in f if x.strip()]
with open('/work/data/words.txt') as f:
    words = [w.strip() for w in f if w.strip()]
print(f'Numbers: {len(nums)}, Sum: {sum(nums)}')
print(f'Words: {len(words)}, First: {words[0]}')
```

STEP 8: Run: shell_execute `python3 /work/scripts/combine.py`

STEP 9: From memory, write /work/answers.txt with EXACTLY these answers:
Line 1: The sum of all numbers (just the integer)
Line 2: The count of words in words.txt (just the integer)
Line 3: The first word in words.txt (just the word)
Line 4: The last word in words.txt (just the word)
