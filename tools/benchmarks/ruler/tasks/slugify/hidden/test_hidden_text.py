import unittest

from text import slugify


class HiddenSlugifyTest(unittest.TestCase):
    def test_issue_examples(self):
        self.assertEqual(slugify('Hello, World!'), 'hello-world')
        self.assertEqual(slugify('a  --  b__c'), 'a-b-c')
        self.assertEqual(slugify('Café Déjà Vu'), 'cafe-deja-vu')

    def test_edges(self):
        self.assertEqual(slugify(' -Leading and trailing- '), 'leading-and-trailing')
        self.assertEqual(slugify('Top 10 Tips!'), 'top-10-tips')
        self.assertEqual(slugify('---'), '')
        self.assertEqual(slugify('?!.,'), '')
        self.assertEqual(slugify('ÀÉÎ õü'), 'aei-ou')
        self.assertEqual(slugify('C++ & Python'), 'c-python')
        self.assertEqual(slugify('Hello World'), 'hello-world')


if __name__ == '__main__':
    unittest.main()
