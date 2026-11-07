import type { common as en } from "../en/common.ts";

/** Jalali (Solar Hijri) calendar date, YYYY-MM-DD with Latin digits
 *  (owner: Latin digits everywhere, Jalali calendar in Persian). */
const jalali = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

function jalaliDate(d: Date): string {
	const parts = jalali.formatToParts(d);
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
	return `${part("year")}-${part("month")}-${part("day")}`;
}

export const common: typeof en = {
	actions: {
		cancel: "لغو",
		close: "بستن",
		save: "ذخیره",
		delete: "حذف",
		remove: "برداشتن",
		rename: "تغییر نام",
		retry: "تلاش دوباره",
		copy: "کپی",
		copied: "کپی شد",
		reset: "بازنشانی",
		edit: "ویرایش",
		add: "افزودن",
		back: "بازگشت",
		next: "بعدی",
		continue: "ادامه",
		confirm: "تأیید",
		dismiss: "نادیده گرفتن",
		open: "باز کردن",
		stop: "توقف",
		send: "ارسال",
		search: "جست‌وجو",
		connect: "اتصال",
		disconnect: "قطع اتصال",
	},
	states: {
		loading: "در حال بارگذاری…",
		saving: "در حال ذخیره…",
		working: "در حال کار…",
		error: "خطا",
		none: "هیچ",
		on: "روشن",
		off: "خاموش",
		default: "پیش‌فرض",
	},
	thinkingLevels: {
		off: "خاموش",
		minimal: "حداقلی",
		low: "کم",
		medium: "متوسط",
		high: "زیاد",
		xhigh: "خیلی زیاد",
		max: "بیشینه",
	},
	time: {
		justNow: "همین حالا",
		minutesAgo: (n) => `${n} دقیقه پیش`,
		hoursAgo: (n) => `${n} ساعت پیش`,
		daysAgo: (n) => `${n} روز پیش`,
		date: jalaliDate,
	},
	markdown: {
		close: "بستن",
		copied: "کپی شد",
		copyCode: "کپی کد",
		copyLink: "کپی پیوند",
		copyTable: "کپی جدول",
		copyTableAsCsv: "کپی جدول به‌صورت CSV",
		copyTableAsMarkdown: "کپی جدول به‌صورت Markdown",
		copyTableAsTsv: "کپی جدول به‌صورت TSV",
		downloadDiagram: "دانلود نمودار",
		downloadDiagramAsMmd: "دانلود نمودار به‌صورت MMD",
		downloadDiagramAsPng: "دانلود نمودار به‌صورت PNG",
		downloadDiagramAsSvg: "دانلود نمودار به‌صورت SVG",
		downloadFile: "دانلود فایل",
		downloadImage: "دانلود تصویر",
		downloadTable: "دانلود جدول",
		downloadTableAsCsv: "دانلود جدول به‌صورت CSV",
		downloadTableAsMarkdown: "دانلود جدول به‌صورت Markdown",
		downloadTableAsTsv: "دانلود جدول به‌صورت TSV",
		exitFullscreen: "خروج از تمام‌صفحه",
		externalLinkWarning: "در حال رفتن به یک وب‌سایت بیرونی هستید.",
		imageNotAvailable: "تصویر در دسترس نیست",
		mermaidFormatMmd: "MMD",
		mermaidFormatPng: "PNG",
		mermaidFormatSvg: "SVG",
		openExternalLink: "پیوند بیرونی باز شود؟",
		openLink: "باز کردن پیوند",
		tableFormatCsv: "CSV",
		tableFormatMarkdown: "Markdown",
		tableFormatTsv: "TSV",
		viewFullscreen: "نمایش تمام‌صفحه",
	},
};
