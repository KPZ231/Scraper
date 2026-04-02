from dataclasses import dataclass, asdict

@dataclass
class Business:
    name:          str             = ""
    address:       str             = ""
    phone:         str             = ""
    email:         str             = ""
    website:       str             = ""
    rating:        str             = ""
    reviews:       str             = ""
    category:      str             = ""
    maps_url:      str             = ""
    is_lead:       bool            = False   # True  → no website found

    def to_dict(self):
        return asdict(self)
