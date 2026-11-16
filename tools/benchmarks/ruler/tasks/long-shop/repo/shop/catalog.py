"""Product catalog. Prices are integer cents, weights are grams."""
from dataclasses import dataclass

from .errors import UnknownProduct


@dataclass(frozen=True)
class Product:
    sku: str
    name: str
    price: int
    category: str
    weight: int


PRODUCTS = {
    "SKU-001": Product("SKU-001", "Classic Widget 1", 719, "office", 250),
    "SKU-002": Product("SKU-002", "Rugged Kettle 2", 24220, "audio", 800),
    "SKU-003": Product("SKU-003", "Classic Planter 3", 4378, "garden", 1500),
    "SKU-004": Product("SKU-004", "Smart Racket 4", 3473, "toys", 1500),
    "SKU-005": Product("SKU-005", "Eco Racket 5", 21084, "garden", 3000),
    "SKU-006": Product("SKU-006", "Smart Notebook 6", 12110, "sports", 250),
    "SKU-007": Product("SKU-007", "Pro Notebook 7", 3259, "office", 1500),
    "SKU-008": Product("SKU-008", "Mini Headset 8", 6602, "sports", 250),
    "SKU-009": Product("SKU-009", "Ultra Blender 9", 25571, "office", 3000),
    "SKU-010": Product("SKU-010", "Compact Stapler 10", 15981, "office", 1500),
    "SKU-011": Product("SKU-011", "Mini Notebook 11", 8853, "audio", 400),
    "SKU-012": Product("SKU-012", "Ultra Lamp 12", 18006, "garden", 120),
    "SKU-013": Product("SKU-013", "Classic Puzzle 13", 879, "kitchen", 800),
    "SKU-014": Product("SKU-014", "Classic Speaker 14", 18944, "books", 120),
    "SKU-015": Product("SKU-015", "Smart Blender 15", 1447, "tools", 800),
    "SKU-016": Product("SKU-016", "Eco Widget 16", 17107, "sports", 1500),
    "SKU-017": Product("SKU-017", "Rugged Lamp 17", 14731, "tools", 250),
    "SKU-018": Product("SKU-018", "Vintage Blender 18", 16288, "sports", 120),
    "SKU-019": Product("SKU-019", "Deluxe Notebook 19", 7529, "sports", 120),
    "SKU-020": Product("SKU-020", "Classic Speaker 20", 2248, "audio", 250),
    "SKU-021": Product("SKU-021", "Vintage Kettle 21", 14349, "kitchen", 250),
    "SKU-022": Product("SKU-022", "Smart Stapler 22", 2775, "toys", 250),
    "SKU-023": Product("SKU-023", "Classic Headset 23", 11101, "books", 400),
    "SKU-024": Product("SKU-024", "Deluxe Headset 24", 24250, "books", 400),
    "SKU-025": Product("SKU-025", "Vintage Widget 25", 5502, "books", 250),
    "SKU-026": Product("SKU-026", "Smart Lamp 26", 14091, "sports", 400),
    "SKU-027": Product("SKU-027", "Mini Notebook 27", 6862, "audio", 400),
    "SKU-028": Product("SKU-028", "Deluxe Puzzle 28", 23866, "kitchen", 250),
    "SKU-029": Product("SKU-029", "Deluxe Kettle 29", 17100, "office", 1500),
    "SKU-030": Product("SKU-030", "Smart Puzzle 30", 6414, "books", 120),
    "SKU-031": Product("SKU-031", "Smart Speaker 31", 1619, "kitchen", 800),
    "SKU-032": Product("SKU-032", "Rugged Racket 32", 11422, "kitchen", 1500),
    "SKU-033": Product("SKU-033", "Mini Stapler 33", 19186, "toys", 800),
    "SKU-034": Product("SKU-034", "Rugged Puzzle 34", 14429, "garden", 400),
    "SKU-035": Product("SKU-035", "Deluxe Widget 35", 13538, "toys", 800),
    "SKU-036": Product("SKU-036", "Compact Stapler 36", 2362, "audio", 120),
    "SKU-037": Product("SKU-037", "Classic Planter 37", 14353, "sports", 3000),
    "SKU-038": Product("SKU-038", "Vintage Stapler 38", 20274, "kitchen", 1500),
    "SKU-039": Product("SKU-039", "Eco Widget 39", 5866, "sports", 3000),
    "SKU-040": Product("SKU-040", "Classic Shovel 40", 13884, "office", 120),
    "SKU-041": Product("SKU-041", "Classic Racket 41", 13089, "garden", 3000),
    "SKU-042": Product("SKU-042", "Deluxe Headset 42", 25682, "tools", 3000),
    "SKU-043": Product("SKU-043", "Smart Widget 43", 688, "audio", 3000),
    "SKU-044": Product("SKU-044", "Rugged Planter 44", 17075, "office", 250),
    "SKU-045": Product("SKU-045", "Classic Planter 45", 19096, "books", 1500),
    "SKU-046": Product("SKU-046", "Rugged Planter 46", 24095, "sports", 400),
    "SKU-047": Product("SKU-047", "Vintage Kettle 47", 22530, "office", 250),
    "SKU-048": Product("SKU-048", "Rugged Shovel 48", 15897, "office", 800),
    "SKU-049": Product("SKU-049", "Pro Racket 49", 10757, "office", 400),
    "SKU-050": Product("SKU-050", "Classic Puzzle 50", 21899, "toys", 400),
    "SKU-051": Product("SKU-051", "Compact Notebook 51", 20651, "books", 120),
    "SKU-052": Product("SKU-052", "Classic Widget 52", 4969, "kitchen", 400),
    "SKU-053": Product("SKU-053", "Mini Racket 53", 2543, "toys", 400),
    "SKU-054": Product("SKU-054", "Mini Notebook 54", 21853, "garden", 800),
    "SKU-055": Product("SKU-055", "Mini Planter 55", 12427, "toys", 3000),
    "SKU-056": Product("SKU-056", "Deluxe Puzzle 56", 18023, "audio", 250),
    "SKU-057": Product("SKU-057", "Rugged Widget 57", 220, "sports", 1500),
    "SKU-058": Product("SKU-058", "Vintage Shovel 58", 25779, "audio", 3000),
    "SKU-059": Product("SKU-059", "Vintage Racket 59", 16734, "kitchen", 250),
    "SKU-060": Product("SKU-060", "Smart Speaker 60", 18824, "garden", 120),
    "SKU-061": Product("SKU-061", "Mini Widget 61", 24589, "audio", 400),
    "SKU-062": Product("SKU-062", "Pro Lamp 62", 11066, "office", 800),
    "SKU-063": Product("SKU-063", "Deluxe Stapler 63", 6619, "books", 800),
    "SKU-064": Product("SKU-064", "Ultra Lamp 64", 10080, "office", 400),
    "SKU-065": Product("SKU-065", "Compact Headset 65", 4514, "audio", 400),
    "SKU-066": Product("SKU-066", "Rugged Planter 66", 14398, "toys", 120),
    "SKU-067": Product("SKU-067", "Vintage Headset 67", 3276, "kitchen", 1500),
    "SKU-068": Product("SKU-068", "Ultra Planter 68", 22227, "books", 3000),
    "SKU-069": Product("SKU-069", "Ultra Puzzle 69", 3259, "audio", 3000),
    "SKU-070": Product("SKU-070", "Eco Headset 70", 19755, "office", 400),
    "SKU-071": Product("SKU-071", "Eco Racket 71", 14937, "books", 400),
    "SKU-072": Product("SKU-072", "Smart Puzzle 72", 23274, "office", 400),
    "SKU-073": Product("SKU-073", "Mini Headset 73", 6546, "sports", 1500),
    "SKU-074": Product("SKU-074", "Vintage Headset 74", 17404, "books", 250),
    "SKU-075": Product("SKU-075", "Classic Racket 75", 19321, "office", 3000),
    "SKU-076": Product("SKU-076", "Deluxe Stapler 76", 13488, "sports", 800),
    "SKU-077": Product("SKU-077", "Compact Headset 77", 17969, "audio", 3000),
    "SKU-078": Product("SKU-078", "Rugged Kettle 78", 21606, "audio", 400),
    "SKU-079": Product("SKU-079", "Ultra Kettle 79", 2278, "garden", 3000),
    "SKU-080": Product("SKU-080", "Mini Lamp 80", 14921, "tools", 120),
    "SKU-081": Product("SKU-081", "Mini Widget 81", 16929, "tools", 400),
    "SKU-082": Product("SKU-082", "Deluxe Speaker 82", 11390, "garden", 400),
    "SKU-083": Product("SKU-083", "Smart Widget 83", 3435, "kitchen", 250),
    "SKU-084": Product("SKU-084", "Ultra Blender 84", 14954, "tools", 250),
    "SKU-085": Product("SKU-085", "Ultra Racket 85", 11840, "toys", 400),
    "SKU-086": Product("SKU-086", "Smart Puzzle 86", 22031, "tools", 3000),
    "SKU-087": Product("SKU-087", "Pro Planter 87", 11169, "toys", 120),
    "SKU-088": Product("SKU-088", "Rugged Headset 88", 17265, "kitchen", 250),
    "SKU-089": Product("SKU-089", "Rugged Racket 89", 6180, "audio", 400),
    "SKU-090": Product("SKU-090", "Compact Widget 90", 25498, "sports", 1500),
    "SKU-091": Product("SKU-091", "Smart Headset 91", 7484, "sports", 3000),
    "SKU-092": Product("SKU-092", "Classic Notebook 92", 16403, "garden", 3000),
    "SKU-093": Product("SKU-093", "Eco Lamp 93", 13929, "garden", 250),
    "SKU-094": Product("SKU-094", "Mini Speaker 94", 18903, "tools", 400),
    "SKU-095": Product("SKU-095", "Eco Puzzle 95", 3703, "office", 250),
    "SKU-096": Product("SKU-096", "Smart Shovel 96", 17480, "audio", 3000),
    "SKU-097": Product("SKU-097", "Compact Widget 97", 14541, "garden", 250),
    "SKU-098": Product("SKU-098", "Vintage Widget 98", 15685, "sports", 120),
    "SKU-099": Product("SKU-099", "Classic Speaker 99", 14188, "audio", 1500),
    "SKU-100": Product("SKU-100", "Vintage Lamp 100", 6396, "office", 800),
    "SKU-101": Product("SKU-101", "Smart Shovel 101", 18475, "garden", 250),
    "SKU-102": Product("SKU-102", "Mini Puzzle 102", 16378, "kitchen", 800),
    "SKU-103": Product("SKU-103", "Pro Planter 103", 11557, "kitchen", 1500),
    "SKU-104": Product("SKU-104", "Eco Headset 104", 15533, "toys", 250),
    "SKU-105": Product("SKU-105", "Classic Blender 105", 3577, "office", 800),
    "SKU-106": Product("SKU-106", "Smart Racket 106", 20595, "sports", 120),
    "SKU-107": Product("SKU-107", "Mini Blender 107", 11098, "garden", 400),
    "SKU-108": Product("SKU-108", "Pro Widget 108", 7674, "tools", 400),
    "SKU-109": Product("SKU-109", "Deluxe Shovel 109", 21658, "sports", 800),
    "SKU-110": Product("SKU-110", "Smart Kettle 110", 18670, "garden", 250),
    "SKU-111": Product("SKU-111", "Compact Notebook 111", 17864, "toys", 3000),
    "SKU-112": Product("SKU-112", "Rugged Stapler 112", 22195, "audio", 800),
    "SKU-113": Product("SKU-113", "Smart Shovel 113", 12232, "tools", 3000),
    "SKU-114": Product("SKU-114", "Rugged Lamp 114", 5594, "garden", 400),
    "SKU-115": Product("SKU-115", "Vintage Lamp 115", 14813, "kitchen", 120),
    "SKU-116": Product("SKU-116", "Classic Shovel 116", 11999, "books", 3000),
    "SKU-117": Product("SKU-117", "Pro Blender 117", 7646, "tools", 120),
    "SKU-118": Product("SKU-118", "Smart Puzzle 118", 23249, "tools", 1500),
    "SKU-119": Product("SKU-119", "Deluxe Planter 119", 4464, "audio", 3000),
    "SKU-120": Product("SKU-120", "Mini Planter 120", 15572, "audio", 250),
    "SKU-121": Product("SKU-121", "Deluxe Widget 121", 7758, "garden", 3000),
    "SKU-122": Product("SKU-122", "Mini Racket 122", 3181, "garden", 3000),
    "SKU-123": Product("SKU-123", "Pro Lamp 123", 24288, "toys", 800),
    "SKU-124": Product("SKU-124", "Smart Notebook 124", 5648, "audio", 3000),
    "SKU-125": Product("SKU-125", "Eco Puzzle 125", 11181, "books", 800),
    "SKU-126": Product("SKU-126", "Vintage Headset 126", 13780, "toys", 400),
    "SKU-127": Product("SKU-127", "Smart Racket 127", 18131, "audio", 800),
    "SKU-128": Product("SKU-128", "Compact Shovel 128", 840, "books", 3000),
    "SKU-129": Product("SKU-129", "Rugged Widget 129", 24295, "sports", 1500),
    "SKU-130": Product("SKU-130", "Pro Planter 130", 21592, "toys", 800),
    "SKU-131": Product("SKU-131", "Classic Kettle 131", 11492, "kitchen", 800),
    "SKU-132": Product("SKU-132", "Eco Lamp 132", 470, "tools", 800),
    "SKU-133": Product("SKU-133", "Vintage Shovel 133", 24652, "toys", 250),
    "SKU-134": Product("SKU-134", "Ultra Headset 134", 14160, "garden", 1500),
    "SKU-135": Product("SKU-135", "Smart Stapler 135", 12294, "tools", 250),
    "SKU-136": Product("SKU-136", "Classic Notebook 136", 25653, "garden", 120),
    "SKU-137": Product("SKU-137", "Compact Notebook 137", 7090, "office", 400),
    "SKU-138": Product("SKU-138", "Pro Notebook 138", 9346, "garden", 400),
    "SKU-139": Product("SKU-139", "Pro Headset 139", 6982, "garden", 1500),
    "SKU-140": Product("SKU-140", "Compact Speaker 140", 20204, "toys", 250),
}


def get(sku):
    """Look a product up by SKU (case-insensitive, surrounding spaces ignored)."""
    key = str(sku).strip().upper()
    try:
        return PRODUCTS[key]
    except KeyError:
        raise UnknownProduct(sku) from None


def in_category(category):
    """All products in a category, cheapest first; ties broken by SKU."""
    return sorted((p for p in PRODUCTS.values() if p.category == category), key=lambda p: (p.price, p.sku))


def search(text):
    """Products whose name contains every word of `text` (case-insensitive)."""
    words = [w for w in str(text).lower().split() if w]
    return [p for p in PRODUCTS.values() if all(w in p.name.lower() for w in words)]
