import { linkProps } from "../lib/router";

export function MissingPageLinks({ section }: { section: "home" | "factory" | "both" | "signin" }) {
	const navigation = (window as Window & { navigation?: { canGoBack: boolean } }).navigation;
	const canGoBack = navigation?.canGoBack ?? history.length > 1;
	return (
		<>
			{canGoBack && (
				<button type="button" className="button button-outline" onClick={() => history.back()}>
					Back
				</button>
			)}
			{(section === "factory" || section === "both") && (
				<a className="button button-outline" {...linkProps({ name: "factory" })}>
					Go to the Factory
				</a>
			)}
			{(section === "home" || section === "both") && (
				<a className="button button-outline" {...linkProps({ name: "home" })}>
					Go to Agents
				</a>
			)}
			{section === "signin" && (
				<a className="button button-outline" {...linkProps({ name: "signin" })}>
					Go to sign in
				</a>
			)}
		</>
	);
}
