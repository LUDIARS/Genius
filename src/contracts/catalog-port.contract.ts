// C-8 catalogServicePort(catalogText, code): the returned port is a valid TCP
// port that the catalog text actually declares for that service code.

export default {
  post: (result: number, catalogText: string, code: string): true | string => {
    if (!Number.isInteger(result) || result < 1 || result > 65_535) {
      return "the port must be an integer between 1 and 65535";
    }
    const declared = new RegExp(`^[ ]+port:[ ]*["']?${result}["']?[ ]*(#.*)?\\r?$`, "m");
    if (!declared.test(catalogText)) {
      return "the port must be declared in the catalog";
    }
    return catalogText.includes(code) || "the catalog must contain the requested service code";
  },
};
