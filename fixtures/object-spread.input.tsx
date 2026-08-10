const emptyState = {
  title: "No projects found",
  description: "Create your first project"
};

export function Page() {
  return <EmptyState {...emptyState} />;
}
