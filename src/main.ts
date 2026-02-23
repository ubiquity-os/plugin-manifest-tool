import { handleRouting, setupRouter } from "./router";
import { initializeState } from "./on-load";

setupRouter();

export async function mainModule() {
  try {
    await initializeState();
    console.log("State initialized");

    await handleRouting();
  } catch (error) {
    console.error("Error in main: ", error);
  }
}

mainModule()
  .then(() => {
    console.log("mainModule loaded");
  })
  .catch((error) => {
    console.error(error);
  });
