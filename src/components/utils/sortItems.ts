import { Items, ListItem, rarityOrder, isAuctionListing } from './Items';

export type SortKey = 'rarity' | 'name' | 'price';
export type SortDir = 'asc' | 'desc';
export type TypeFilter = 'all' | 'auction' | 'fixed';

export type Sortable = Items | ListItem;

/**
 * What to sort a listing by.
 *
 * For an auction with no bids yet this is the reserve, because it is the only
 * number that exists — the highest bid is still zero. Once bids land the
 * current highest bid takes over.
 */
export const effectivePrice = (x: ListItem): number =>
    isAuctionListing(x) && x.clearingPrice > 0 ? x.clearingPrice : x.price;

const rarityRank = (r: string): number => rarityOrder[r] ?? 99;

export const compareItems =
    (sortBy: SortKey, dir: SortDir) =>
    (a: Sortable, b: Sortable): number => {
        let diff = 0;
        if (sortBy === 'rarity') diff = rarityRank(String(a.rarity)) - rarityRank(String(b.rarity));
        if (sortBy === 'name') diff = a.name.localeCompare(b.name);
        if (sortBy === 'price') {
            const pa = 'listingId' in a ? effectivePrice(a) : 0;
            const pb = 'listingId' in b ? effectivePrice(b) : 0;
            diff = pa - pb;
        }
        if (dir === 'desc') diff = -diff;
        return diff !== 0 ? diff : a.name.localeCompare(b.name);
    };

export const filterByType = <T extends Sortable>(list: T[], t: TypeFilter): T[] => {
    if (t === 'all') return list;
    return list.filter(x => {
        const isAuction = 'listingType' in x && isAuctionListing(x);
        return t === 'auction' ? isAuction : !isAuction;
    });
};

export const parseSortValue = (v: string): { key: SortKey; dir: SortDir } => {
    const [key, dir] = v.split('-') as [SortKey, SortDir];
    return { key, dir };
};
