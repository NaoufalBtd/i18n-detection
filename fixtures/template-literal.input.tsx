export function Page({ count }: { count: number }) {
  toast.success(`Deleted ${count} projects`);
  return <div>Empty</div>;
}
