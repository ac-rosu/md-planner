#   M9 – Odd   spacing   ##

id:   M9    # comment with  spaces
target:2026-12-01
status: active #comment-without-leading-space-is-part-of-value
depends:
empty: # only a comment

Text right under the block.   
Trailing spaces above are kept.

##	Tabs	and   stuff

-   [ ]   Lots   of    space   @est:4h    #tag     ^T900   
* [x] Star marker @est:1d @act:7.5h ^T901
+ [/] Plus marker @owner:sam @custom:"quoted value with \"escapes\"" ^T902
1. [?] Ordered item @prio:high ^T903
2) [!] Paren ordered @blocked:"waiting" ^T904
	- [ ] Tab-indented child @est:2h ^T905
	  continuation note with tab indent
- [ ] Unknown status? no: [z] is not mine
- [z] Unknown status char @est:1h ^T906
- [-] Cancelled @est:3h ^T907
- [x]
- [ ]

  Paragraph inside list after blank line.

```md
- [ ] Not a task inside a fence ^T999
## Not a heading
```

~~~
- [x] tilde fence
~~~

> - [ ] quoted list item is free text

- Plain list item
  - [ ] nested checkbox under plain item @est:1h ^T908
