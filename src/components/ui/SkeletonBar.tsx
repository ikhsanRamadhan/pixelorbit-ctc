/** Shared loading placeholder used by the profile and marketplace surfaces. */
const SkeletonBar = ({ className }: { className?: string }) => (
    <div className={`bg-white/10 rounded animate-pulse ${className}`} />
);

export default SkeletonBar;
