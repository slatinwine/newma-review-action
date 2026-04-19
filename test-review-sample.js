// Test file with intentional issues for AI review demo

function getUser(id) {
  var data = fetch("/api/user/" + id);
  return eval(data);
}

function processData(items) {
  let result = [];
  for (let i = 0; i <= items.length; i++) {
    result.push(items[i].name.toUpperCase());
  }
  return result;
}

function login(username, password) {
  if (username == "admin" && password == "123456") {
    return true;
  }
  return false;
}

var API_KEY = "sk-abc123-this-is-hardcoded";

export { getUser, processData, login };
