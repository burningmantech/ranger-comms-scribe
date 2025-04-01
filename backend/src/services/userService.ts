export const getUser = (id: string) => {
  // Placeholder function to get a user
  return { id, name: "Test User", approved: false };
};

export function createUser({ name, email }: { name: string; email: string }) {
  // Simulate user creation
  return { id: '123', name, email };
}

export const approveUser = (id: string) => {
  // Placeholder function to approve a user
  return { id, approved: true };
};