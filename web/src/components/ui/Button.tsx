/**
 * Buttons. `Button` draws the app's button classes (base.css) by variant and size; `SplitButton` is a
 * primary action with a chevron beside it that opens the other ways to do it (a menu).
 */
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { ChevronDownIcon } from "../Icons";
import { Menu, type MenuSpec } from "./Menu";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "stop";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
	primary: "button-primary",
	secondary: "button-outline",
	ghost: "button-quiet",
	danger: "button-danger",
	stop: "button-stop",
};
const SIZE: Record<ButtonSize, string> = { sm: " button-small", md: "", lg: " button-large" };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	icon?: ReactNode;
	ref?: Ref<HTMLButtonElement>;
}

export function Button({
	variant = "secondary",
	size = "md",
	icon,
	className,
	children,
	type = "button",
	...rest
}: ButtonProps) {
	return (
		<button
			type={type}
			className={`button ${VARIANT[variant]}${SIZE[size]}${className ? ` ${className}` : ""}`}
			{...rest}
		>
			{icon}
			{children === undefined || children === null ? null : <span>{children}</span>}
		</button>
	);
}

export interface SplitButtonProps extends Omit<ButtonProps, "variant"> {
	/** The other ways to do it. */
	menu: MenuSpec;
	/** The chevron's accessible name. */
	menuLabel: string;
	menuDisabled?: boolean;
}

/** The action, and a chevron that opens its menu; the two read as one control. */
export function SplitButton({
	menu,
	menuLabel,
	menuDisabled = false,
	size = "md",
	className,
	...rest
}: SplitButtonProps) {
	return (
		<span className={`ui-split ui-split-${size}${className ? ` ${className}` : ""}`}>
			<Button variant="primary" size={size} className="ui-split-main" {...rest} />
			<Menu
				spec={menu}
				align="end"
				trigger={props => (
					<button
						type="button"
						className="button button-primary ui-split-more"
						aria-label={menuLabel}
						disabled={menuDisabled}
						{...props}
					>
						<ChevronDownIcon size={14} />
					</button>
				)}
			/>
		</span>
	);
}
