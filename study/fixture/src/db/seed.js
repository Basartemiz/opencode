// Sample data loaded when the service starts.

const BOOKS = [
  ["The Left Hand of Darkness", "Ursula K. Le Guin", "fiction", 1969],
  ["Snow Crash", "Neal Stephenson", "fiction", 1992],
  ["The Pragmatic Programmer", "Andrew Hunt", "tech", 1999],
  ["Designing Data-Intensive Applications", "Martin Kleppmann", "tech", 2017],
  ["A Short History of Nearly Everything", "Bill Bryson", "science", 2003],
  ["The Gene", "Siddhartha Mukherjee", "science", 2016],
  ["Persepolis", "Marjane Satrapi", "comics", 2000],
  ["The Name of the Rose", "Umberto Eco", "fiction", 1980],
]

const MEMBERS = [
  ["Ayşe Kaya", "ayse@example.org"],
  ["Mehmet Demir", "mehmet@example.org"],
  ["Elif Şahin", "elif@example.org"],
  ["Can Yılmaz", "can@example.org"],
]

export function seed({ insert, nextId }) {
  for (const [title, author, genre, year] of BOOKS) {
    insert("books", { id: nextId("book"), title, author, genre, year, copies: 1, active: true })
  }
  for (const [name, email] of MEMBERS) {
    insert("members", {
      id: nextId("member"),
      name,
      email,
      joined: "2025-09-01T00:00:00.000Z",
      balance: 0,
      active: true,
    })
  }
}
