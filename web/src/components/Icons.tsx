/**
 * The interface's glyphs, drawn rather than typed, so they look the same whatever fonts the machine
 * has. All are 16 units square, stroke in the current colour, and hidden from assistive technology:
 * the text beside each one says what it means.
 */
import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
			{children}
		</svg>
	);
}

export const CheckIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M3 8.6l3.2 3.2L13 4.6" />
	</Svg>
);

export const CrossIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M4 4l8 8M12 4l-8 8" />
	</Svg>
);

export const RingIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="4.6" />
	</Svg>
);

export const DotIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />
	</Svg>
);

/** Refused: a circle with a bar through it. */
export const RefusedIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="5.2" />
		<path d="M4.4 11.6l7.2-7.2" />
	</Svg>
);

export const StopIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" stroke="none" />
	</Svg>
);

export const ChevronIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M6 3.5L10.5 8 6 12.5" />
	</Svg>
);

export const ArrowDownIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 3v9.4M4 8.8L8 12.8l4-4" />
	</Svg>
);

export const ArrowLeftIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M13 8H3.6M7.2 4L3.2 8l4 4" />
	</Svg>
);

export const SendIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 13V3.6M4 7.2L8 3.2l4 4" />
	</Svg>
);

export const PlusIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 3v10M3 8h10" />
	</Svg>
);

export const PencilIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M10.6 2.9l2.5 2.5-7.4 7.4-3 .5.5-3z" />
	</Svg>
);

export const TrashIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M3 4.5h10M6.2 4.5V3h3.6v1.5M4.4 4.5l.6 8.5h6l.6-8.5" />
	</Svg>
);

export const SunIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="2.8" />
		<path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M3.5 12.5l1.1-1.1M11.4 4.6l1.1-1.1" />
	</Svg>
);

export const MoonIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M13.2 9.4A5.6 5.6 0 016.6 2.8a5.6 5.6 0 106.6 6.6z" />
	</Svg>
);

export const ExternalIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M9 3h4v4M13 3L7.4 8.6M11 9.4V13H3V5h3.6" />
	</Svg>
);

export const WarnIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 2.4l6 10.6H2z" />
		<path d="M8 6.6v3M8 11.4v.2" />
	</Svg>
);

/** A question waits on the user: a mark of interrogation in a ring. */
export const AskIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="5.8" />
		<path d="M6.3 6.4a1.8 1.8 0 113 1.3c-.6.4-1.3.8-1.3 1.6M8 11.1v.1" />
	</Svg>
);

/** A steer: a line that bends into the work already under way. */
export const SteerIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M3 3.5v3.2a3 3 0 003 3h6.5M10 7l2.6 2.7L10 12.4" />
	</Svg>
);

export const InfoIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="5.6" />
		<path d="M8 7.4v3.4M8 5.2v.2" />
	</Svg>
);

/** Ran inside Windlass's own sandbox: a dot in a box, as the terminal interface marks it. */
export const SandboxedIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="3" y="3" width="10" height="10" rx="1.4" />
		<circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
	</Svg>
);

/** Reasoning: three dots, "therefore". */
export const ThoughtIcon = (props: IconProps) => (
	<Svg {...props} stroke="none" fill="currentColor">
		<circle cx="8" cy="4.4" r="1.4" />
		<circle cx="4.4" cy="10.8" r="1.4" />
		<circle cx="11.6" cy="10.8" r="1.4" />
	</Svg>
);

export const FileIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M4 2.5h5l3 3v8H4z" />
		<path d="M9 2.5v3h3" />
	</Svg>
);

export const RefreshIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M13 8a5 5 0 11-1.6-3.7" />
		<path d="M13.2 2.6v2.8h-2.8" />
	</Svg>
);

export const UserIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="5.6" r="2.6" />
		<path d="M3 13.4c.6-2.4 2.6-3.6 5-3.6s4.400 1.200 5 3.600" />
	</Svg>
);

/**
 * The mark: a windlass seen end on. A drum with three handspikes and the line it hauls, running off
 * its side and down to a link. With `turning` the drum turns, which is how the interface says an
 * agent is at work.
 */
export function Mark({ size = 20, turning = false, className }: { size?: number; turning?: boolean; className?: string }) {
	return (
		<svg width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true" focusable="false" className={`mark${turning ? " mark-turning" : ""}${className ? ` ${className}` : ""}`}>
			<g className="mark-drum">
				<circle cx="11.5" cy="11.5" r="7.5" />
				<path d="M11.5 4v4.2M5 15.25l3.64-2.1M18 15.25l-3.64-2.1" />
				<circle cx="11.5" cy="11.5" r="1.5" fill="currentColor" stroke="none" />
			</g>
			<path d="M19 11.5V23" />
			<rect x="17" y="22" width="4" height="4" rx="1" fill="currentColor" stroke="none" />
		</svg>
	);
}
