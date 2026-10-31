text.py 的 slugify 处理不了标点和多余的分隔符，网址里出现了 `hello,-world!` 这种东西。期望：
- `slugify('Hello, World!')` → `'hello-world'`
- 连续的空格、横线、下划线都折成一个 `-`：`slugify('a  --  b__c')` → `'a-b-c'`
- 开头和结尾不留 `-`
- 带重音的拉丁字母去掉重音：`slugify('Café Déjà Vu')` → `'cafe-deja-vu'`
- 数字保留
- 全是标点时返回空字符串
