"use client";

import { useCallback, useEffect, useState } from "react";

/** Device preference (all sessions): check the transcript before it is sent. Default on. */
const STORAGE_KEY = "lh:region-review";

export function useReviewBeforeSend(): [boolean, (value: boolean) => void] {
	const [review, setReview] = useState(true);
	useEffect(() => {
		try {
			if (localStorage.getItem(STORAGE_KEY) === "off") setReview(false);
		} catch {
			// storage unavailable: the default stands
		}
	}, []);
	const update = useCallback((value: boolean) => {
		setReview(value);
		try {
			localStorage.setItem(STORAGE_KEY, value ? "on" : "off");
		} catch {
			// not remembered
		}
	}, []);
	return [review, update];
}
