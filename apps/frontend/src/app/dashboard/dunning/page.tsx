import DunningWorkflowView from "@/components/dashboard/views/dunning-workflow-view";

export const metadata = {
  title: "Dunning workflow | Orbit",
};

export default function DunningPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <DunningWorkflowView />
    </main>
  );
}
