import unittest
from datetime import date

from dates import parse_date
from errors import ValidationError


class HiddenParseDateTest(unittest.TestCase):
    def test_formats(self):
        self.assertEqual(parse_date('2024/03/05'), date(2024, 3, 5))
        self.assertEqual(parse_date('2024-03-05'), date(2024, 3, 5))
        self.assertEqual(parse_date('2023/12/31'), date(2023, 12, 31))

    def test_bad_input_is_validation_error(self):
        for bad in ['2024-02-30', '2024-xx-01', '2024/13/01', '', '2024-03', 'hello']:
            with self.subTest(bad=bad):
                with self.assertRaises(ValidationError):
                    parse_date(bad)


if __name__ == '__main__':
    unittest.main()
