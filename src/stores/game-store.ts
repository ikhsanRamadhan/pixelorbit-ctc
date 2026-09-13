import { create } from 'zustand'
import type { Items, ListItem } from '@/components/utils/Items'
import type { MySpaceships } from '@/components/utils/Spaceships'
import type { HighscoreMessage, ShipLeaderboards } from '@/services/types'

interface GameState {
    ownedItems: Items[]
    userHighscores: HighscoreMessage[]
    leaderboard: HighscoreMessage[]
    shipLeaderboards: ShipLeaderboards
    totalUser: number
    mySpaceships: MySpaceships[]
    userListings: ListItem[]
    allListing: ListItem[]
    isLoading: boolean
    isFleetLoading: boolean

    setOwnedItems: (items: Items[]) => void
    setUserHighscores: (scores: HighscoreMessage[]) => void
    setLeaderboard: (scores: HighscoreMessage[]) => void
    setShipLeaderboards: (boards: ShipLeaderboards) => void
    setTotalUser: (n: number) => void
    setMySpaceships: (ships: MySpaceships[]) => void
    setUserListings: (listings: ListItem[]) => void
    setAllListing: (listings: ListItem[]) => void
    setIsLoading: (loading: boolean) => void
    setIsFleetLoading: (loading: boolean) => void
    resetUserData: () => void
    reset: () => void
}

const initialState = {
    ownedItems: [],
    userHighscores: [],
    leaderboard: [],
    shipLeaderboards: {},
    totalUser: 0,
    mySpaceships: [],
    userListings: [],
    allListing: [],
    isLoading: false,
    isFleetLoading: false,
}

export const useGameStore = create<GameState>((set) => ({
    ...initialState,
    setOwnedItems: (ownedItems) => set({ ownedItems }),
    setUserHighscores: (userHighscores) => set({ userHighscores }),
    setLeaderboard: (leaderboard) => set({ leaderboard }),
    setShipLeaderboards: (shipLeaderboards) => set({ shipLeaderboards }),
    setTotalUser: (totalUser) => set({ totalUser }),
    setMySpaceships: (mySpaceships) => set({ mySpaceships }),
    setUserListings: (userListings) => set({ userListings }),
    setAllListing: (allListing) => set({ allListing }),
    setIsLoading: (isLoading) => set({ isLoading }),
    setIsFleetLoading: (isFleetLoading) => set({ isFleetLoading }),
    resetUserData: () => set({
        ownedItems: [],
        userHighscores: [],
        mySpaceships: [],
        userListings: [],
        isFleetLoading: false,
    }),
    reset: () => set(initialState),
}))