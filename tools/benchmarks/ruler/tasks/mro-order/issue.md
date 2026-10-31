handlers.py 的 collect_handlers 在多继承时只看第一个父类：`class C(A, B)` 收不到 B 上声明的 handlers。
要把所有父类的都收进来；同一个 handler 在好几个父类上都有时只留一个。
