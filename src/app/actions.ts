"use server";

import { cookies } from "next/headers";

export async function setAccountIdCookie(accountId: string | null) {
    const cookieStore = await cookies();

    if (!accountId) {
        cookieStore.delete("accountId");
        return { success: true, message: "Cookie deleted" };
    }

    cookieStore.set("accountId", accountId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        maxAge: 60 * 60 * 24 * 7,
        path: "/",
        sameSite: "lax",
    });

    return { success: true, accountId };
}

export async function deleteAccountIdCookie() {
    const cookieStore = await cookies();
    cookieStore.delete("accountId");
    return { success: true, message: "Cookie deleted" };
}

export async function getAccountIdCookie() {
    const cookieStore = await cookies();
    const accountId = cookieStore.get("accountId")?.value;
    return { success: true, accountId };
}